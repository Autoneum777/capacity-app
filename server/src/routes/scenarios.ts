import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'os';
import { Router } from 'express';
import { db, saveDb } from '../db/connection.js';
import { formatDetailSapAliasLabel } from '../utils/detailLabel.js';
import { loadReferenceDisplayMode } from '../utils/referenceDisplayMode.js';
import { parseCsvQueryParamSingleOrMulti, parseIdList } from '../utils/queryListParams.js';
import { clientNamesMatch, normalizeClientName, parseClientFilterQuery } from '../utils/clientName.js';
import {
  applyScenarioBundleSubsetToProduction,
  applyScenarioBundleToProduction,
  cloneScenarioBundle,
  exportLiveScenarioBundle,
  parseScenarioSnapshotJson,
  pushScenarioAudit,
  listProductionProjectsNotInBundle,
  appendProductionProjectsToBundle,
} from '../services/scenarioSnapshotService.js';
export const scenariosRouter = Router();

const DEPLOY_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** Sekret HMAC dla tokena wgrywania (bez trzymania kodu w RAM — działa po restarcie serwera). Ustaw CAPACITY_DEPLOY_SECRET w produkcji. */
function deploySecret(): string {
  return process.env.CAPACITY_DEPLOY_SECRET || 'capacity-dev-deploy-secret-change-in-production';
}

type DeployProofPayload = { v: 1; sid: number; phrase: string; exp: number };

function signDeployProof(p: DeployProofPayload): string {
  const body = JSON.stringify(p);
  const sig = createHmac('sha256', deploySecret()).update(body).digest('hex');
  return Buffer.from(JSON.stringify({ p, sig }), 'utf8').toString('base64url');
}

function verifyDeployProof(
  token: string,
  expectedScenarioId: number,
  typedPhrase: string
): { ok: true } | { ok: false } {
  let raw: { p: DeployProofPayload; sig: string };
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { p: DeployProofPayload; sig: string };
  } catch {
    return { ok: false };
  }
  if (!raw?.p || raw.p.v !== 1 || typeof raw.sig !== 'string') return { ok: false };
  const body = JSON.stringify(raw.p);
  const expectSig = createHmac('sha256', deploySecret()).update(body).digest('hex');
  try {
    if (expectSig.length !== raw.sig.length || !timingSafeEqual(Buffer.from(expectSig, 'utf8'), Buffer.from(raw.sig, 'utf8'))) {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }
  const { sid, phrase, exp } = raw.p;
  if (sid !== expectedScenarioId) return { ok: false };
  if (Date.now() > exp) return { ok: false };
  if (typedPhrase.trim() !== phrase) return { ok: false };
  return { ok: true };
}

function randomDeployPhrase(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

function resolveScenarioActor(req: any): string {
  const fromHeader = String(req.headers?.['x-user-login'] ?? req.headers?.['x-user'] ?? '').trim();
  if (fromHeader) return fromHeader;
  const envUser = String(process.env.USERNAME ?? process.env.USER ?? '').trim();
  if (envUser) return envUser;
  try {
    return os.userInfo().username || 'system';
  } catch {
    return 'system';
  }
}

scenariosRouter.get('/', (req, res) => {
  const archivedParam = String(req.query?.archived ?? '').toLowerCase();
  const wantArchived = archivedParam === '1' || archivedParam === 'true';
  const activeClause = wantArchived ? 's.archived_at IS NOT NULL' : 's.archived_at IS NULL';

  try {
    const list = db
      .prepare(
        `SELECT s.id, s.name, s.created_at, s.source_scenario_id, s.updated_at, s.scenario_scope, s.archived_at,
                s.source_call_off_comparison_id,
                ps.name AS source_scenario_name,
                co.name AS source_call_off_name
         FROM scenarios s
         LEFT JOIN scenarios ps ON ps.id = s.source_scenario_id
         LEFT JOIN call_off_comparisons co ON co.id = s.source_call_off_comparison_id
         WHERE ${activeClause}
         ORDER BY ${wantArchived ? 's.archived_at DESC, s.created_at DESC' : 's.created_at DESC'}`
      )
      .all() as any[];
    res.json(list);
  } catch {
    try {
      const list = db
        .prepare(
          `SELECT s.id, s.name, s.created_at, s.source_scenario_id, s.updated_at,
                  ps.name AS source_scenario_name
           FROM scenarios s
           LEFT JOIN scenarios ps ON ps.id = s.source_scenario_id
           ORDER BY s.created_at DESC`
        )
        .all() as any[];
      res.json(list.map((r) => ({ ...r, scenario_scope: (r as any).scenario_scope ?? '', archived_at: null })));
    } catch {
      const list = db.prepare('SELECT id, name, created_at FROM scenarios ORDER BY created_at DESC').all() as any[];
      res.json(list.map((r) => ({ ...r, source_scenario_id: null, source_scenario_name: null, updated_at: null, scenario_scope: '', archived_at: null })));
    }
  }
});

scenariosRouter.get('/:id/deploy-challenge', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  const phrase = randomDeployPhrase();
  const exp = Date.now() + DEPLOY_CHALLENGE_TTL_MS;
  const deployToken = signDeployProof({ v: 1, sid: id, phrase, exp });
  res.json({ phrase, expiresInSec: Math.floor(DEPLOY_CHALLENGE_TTL_MS / 1000), deployToken });
});

/** Nowe projekty wyłącznie w wersji Capacity (produkcja) — nie w snapshotcie scenariusza. */
scenariosRouter.post('/:id/projects', (_req, res) => {
  res.status(403).json({ error: 'Nowe projekty i detale tworzy się tylko w wersji Capacity (produkcja). Użyj Projekty w trybie Wersja Capacity.' });
});

/** Zmiana statusu / dat SOP-EOP projektu w snapshotcie scenariusza (nie zmienia produkcji). */
scenariosRouter.patch('/:id/projects/:projectId', (req, res) => {
  const id = Number(req.params.id);
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId) || projectId <= 0) return res.status(400).json({ error: 'Nieprawidłowy identyfikator projektu.' });
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — edycja jest wyłączona.' });
  }
  const body = (req.body ?? {}) as { status?: unknown; sop?: unknown; eop?: unknown };
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  const hasSop = Object.prototype.hasOwnProperty.call(body, 'sop');
  const hasEop = Object.prototype.hasOwnProperty.call(body, 'eop');
  if (!hasStatus && !hasSop && !hasEop) {
    return res.status(400).json({ error: 'Podaj status, sop lub eop.' });
  }
  let status: string | null = null;
  if (hasStatus) {
    const statusRaw = String(body.status ?? '').trim();
    status = ['active', 'inactive', 'RFQ'].includes(statusRaw) ? statusRaw : null;
    if (!status) return res.status(400).json({ error: 'Podaj status: active, inactive lub RFQ.' });
  }
  const sop = hasSop ? String(body.sop ?? '').trim() : null;
  const eop = hasEop ? String(body.eop ?? '').trim() : null;
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const projects = bundle.projects || [];
    const idx = projects.findIndex((p: any) => Number(p.id) === projectId);
    if (idx < 0) return res.status(404).json({ error: 'Projekt nie występuje w tym scenariuszu.' });
    const proj = projects[idx] as any;
    const changes: string[] = [];
    if (hasStatus && status != null) {
      const prev = String(proj.status ?? 'active');
      if (prev !== status) {
        proj.status = status;
        changes.push(`status: „${prev}” → „${status}”`);
      }
    }
    if (hasSop) {
      const prev = String(proj.sop ?? '');
      if (prev !== sop) {
        proj.sop = sop;
        changes.push(`SOP: „${prev || '—'}” → „${sop || '—'}”`);
      }
    }
    if (hasEop) {
      const prev = String(proj.eop ?? '');
      if (prev !== eop) {
        proj.eop = eop;
        changes.push(`EOP: „${prev || '—'}” → „${eop || '—'}”`);
      }
    }
    if (changes.length === 0) {
      return res.json({ id: projectId, status: proj.status ?? 'active', sop: proj.sop ?? null, eop: proj.eop ?? null, unchanged: true });
    }
    bundle.projects = projects;
    pushScenarioAudit(bundle, {
      author: resolveScenarioActor(req),
      note_type: 'auto',
      note: `Zmiana projektu #${projectId}: ${changes.join('; ')}.`,
      project_id: projectId,
    });
    try {
      db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), id);
    } catch {
      db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), id);
    }
    saveDb();
    res.json({ id: projectId, status: proj.status ?? 'active', sop: proj.sop ?? null, eop: proj.eop ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd zapisu zmian projektu w scenariuszu' });
  }
});

/** Zmiana statusu detalu (części) w snapshotcie — tylko scenariusz; pole `status` nie istnieje w produkcji. */
scenariosRouter.patch('/:id/parts/:partId', (req, res) => {
  const id = Number(req.params.id);
  const partId = Number(req.params.partId);
  if (!Number.isFinite(partId) || partId <= 0) return res.status(400).json({ error: 'Nieprawidłowy identyfikator detalu.' });
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — edycja statusów jest wyłączona.' });
  }
  if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status')) {
    return res.status(400).json({ error: 'Podaj pole status (active, inactive, RFQ lub null aby dziedziczyć z projektu).' });
  }
  const raw = (req.body as any).status;
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const parts = bundle.parts || [];
    const idx = parts.findIndex((pt: any) => Number(pt.id) === partId);
    if (idx < 0) return res.status(404).json({ error: 'Detal nie występuje w tym scenariuszu.' });
    const prev = (parts[idx] as any).status;
    const prevStr = prev == null || prev === '' ? null : String(prev);
    if (raw === null || raw === '') {
      if (prevStr == null) {
        return res.json({ id: partId, status: null, unchanged: true });
      }
      delete (parts[idx] as any).status;
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Zmiana statusu detalu #${partId}: usunięto nadpisanie (dziedziczenie z projektu).`,
        project_id: Number((parts[idx] as any).project_id) || null,
        part_id: partId,
      });
    } else {
      const statusRaw = String(raw).trim();
      const status = ['active', 'inactive', 'RFQ'].includes(statusRaw) ? statusRaw : null;
      if (!status) return res.status(400).json({ error: 'Podaj status: active, inactive lub RFQ (albo null).' });
      if (prevStr === status) {
        return res.json({ id: partId, status, unchanged: true });
      }
      (parts[idx] as any).status = status;
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Zmiana statusu detalu #${partId}: „${prevStr ?? 'dziedziczy'}” → „${status}”.`,
        project_id: Number((parts[idx] as any).project_id) || null,
        part_id: partId,
      });
    }
    bundle.parts = parts;
    try {
      db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), id);
    } catch {
      db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), id);
    }
    saveDb();
    res.json({ id: partId, status: (parts[idx] as any).status ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd zapisu statusu detalu w scenariuszu' });
  }
});

const SCENARIO_VOLUME_UNITS = ['annual', 'monthly', 'weekly'] as const;

/**
 * Wolumen detalu (roczne wartości) w snapshotcie scenariusza — tylko ten scenariusz, bez wpływu na produkcję.
 * `{ mode: 'override', volumes: [...] }` zapisuje nadpisanie na wskazane lata.
 * `{ mode: 'project' }` usuwa nadpisanie (detal wraca do dziedziczenia wolumenu z projektu).
 */
scenariosRouter.put('/:id/parts/:partId/volumes', (req, res) => {
  const id = Number(req.params.id);
  const partId = Number(req.params.partId);
  if (!Number.isFinite(partId) || partId <= 0) return res.status(400).json({ error: 'Nieprawidłowy identyfikator detalu.' });
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — edycja jest wyłączona.' });
  }
  const body = (req.body ?? {}) as {
    mode?: unknown;
    volumes?: { year?: unknown; volume_value?: unknown; volume_unit?: unknown }[];
  };
  const mode = String(body.mode ?? 'override').trim();
  if (mode !== 'override' && mode !== 'project') {
    return res.status(400).json({ error: 'Podaj mode: override lub project.' });
  }
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const parts = bundle.parts || [];
    const idx = parts.findIndex((pt: any) => Number(pt.id) === partId);
    if (idx < 0) return res.status(404).json({ error: 'Detal nie występuje w tym scenariuszu.' });
    const part = parts[idx] as any;
    const projectId = Number(part.project_id) || null;
    const before = bundle.part_volume_by_year || [];
    const others = before.filter((r: any) => Number(r.part_id) !== partId);

    if (mode === 'project') {
      const hadOverride = String(part.volume_mode ?? 'project') === 'override';
      if (!hadOverride && others.length === before.length) {
        return res.json({ id: partId, volume_mode: 'project', volumes: [], unchanged: true });
      }
      part.volume_mode = 'project';
      bundle.part_volume_by_year = others;
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Wolumen detalu #${partId}: usunięto nadpisanie (dziedziczy z projektu).`,
        project_id: projectId,
        part_id: partId,
      });
    } else {
      const entries = (Array.isArray(body.volumes) ? body.volumes : [])
        .map((v) => ({
          year: Math.trunc(Number(v?.year)),
          volume_value: Number(v?.volume_value),
          volume_unit: SCENARIO_VOLUME_UNITS.includes(v?.volume_unit as any) ? (v!.volume_unit as string) : 'annual',
        }))
        .filter(
          (v) => Number.isFinite(v.year) && v.year >= 1900 && v.year <= 2200 && Number.isFinite(v.volume_value) && v.volume_value >= 0
        );
      if (entries.length === 0) {
        return res.status(400).json({ error: 'Podaj przynajmniej jeden rok z wolumenem (≥ 0).' });
      }
      part.volume_mode = 'override';
      bundle.part_volume_by_year = [
        ...others,
        ...entries.map((e) => ({
          part_id: partId,
          year: e.year,
          volume_value: e.volume_value,
          volume_unit: e.volume_unit,
          volume_origin: 'manual_year',
        })),
      ];
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Wolumen detalu #${partId}: nadpisanie (tylko scenariusz) dla lat ${entries.map((e) => e.year).join(', ')}.`,
        project_id: projectId,
        part_id: partId,
      });
    }
    bundle.parts = parts;
    try {
      db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), id);
    } catch {
      db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), id);
    }
    saveDb();
    res.json({
      id: partId,
      volume_mode: part.volume_mode ?? 'project',
      volumes: (bundle.part_volume_by_year || [])
        .filter((r: any) => Number(r.part_id) === partId)
        .sort((a: any, b: any) => Number(a.year) - Number(b.year)),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd zapisu wolumenu detalu w scenariuszu' });
  }
});

/** Zmiana statusu operacji w snapshotcie — tylko scenariusz. */
scenariosRouter.patch('/:id/operations/:operationId', (req, res) => {
  const id = Number(req.params.id);
  const operationId = Number(req.params.operationId);
  if (!Number.isFinite(operationId) || operationId <= 0) return res.status(400).json({ error: 'Nieprawidłowy identyfikator operacji.' });
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — edycja statusów jest wyłączona.' });
  }
  if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'status')) {
    return res.status(400).json({ error: 'Podaj pole status (active, inactive, RFQ lub null aby dziedziczyć z detalu/projekt).' });
  }
  const raw = (req.body as any).status;
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const ops = bundle.operations || [];
    const idx = ops.findIndex((o: any) => Number(o.id) === operationId);
    if (idx < 0) return res.status(404).json({ error: 'Operacja nie występuje w tym scenariuszu.' });
    const prev = (ops[idx] as any).status;
    const prevStr = prev == null || prev === '' ? null : String(prev);
    if (raw === null || raw === '') {
      if (prevStr == null) {
        return res.json({ id: operationId, status: null, unchanged: true });
      }
      delete (ops[idx] as any).status;
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Zmiana statusu operacji #${operationId}: usunięto nadpisanie (dziedziczenie z detalu/projekt).`,
        project_id: Number((ops[idx] as any).project_id) || null,
        part_id: Number((ops[idx] as any).part_id) || null,
        operation_id: operationId,
      });
    } else {
      const statusRaw = String(raw).trim();
      const status = ['active', 'inactive', 'RFQ'].includes(statusRaw) ? statusRaw : null;
      if (!status) return res.status(400).json({ error: 'Podaj status: active, inactive lub RFQ (albo null).' });
      if (prevStr === status) {
        return res.json({ id: operationId, status, unchanged: true });
      }
      (ops[idx] as any).status = status;
      pushScenarioAudit(bundle, {
        author: resolveScenarioActor(req),
        note_type: 'auto',
        note: `Zmiana statusu operacji #${operationId}: „${prevStr ?? 'dziedziczy'}” → „${status}”.`,
        project_id: Number((ops[idx] as any).project_id) || null,
        part_id: Number((ops[idx] as any).part_id) || null,
        operation_id: operationId,
      });
    }
    bundle.operations = ops;
    try {
      db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), id);
    } catch {
      db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), id);
    }
    saveDb();
    res.json({ id: operationId, status: (ops[idx] as any).status ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd zapisu statusu operacji w scenariuszu' });
  }
});

/** Projekty z Capacity (produkcja), których nie ma w snapshotcie — do modala „Dodaj projekty”. */
scenariosRouter.get('/:id/addable-projects', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — dodawanie projektów jest wyłączone.' });
  }
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    res.json(listProductionProjectsNotInBundle(bundle));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd odczytu scenariusza' });
  }
});

/** Dołącza wybrane projekty z produkcji do snapshotu (pełna kopia powiązań — kalkulator scenariusza). */
scenariosRouter.post('/:id/add-projects-from-capacity', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot, archived_at FROM scenarios WHERE id = ?').get(id) as
    | { snapshot: string; archived_at: string | null }
    | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.archived_at != null && String(row.archived_at).trim() !== '') {
    return res.status(400).json({ error: 'Scenariusz zarchiwizowany — dodawanie projektów jest wyłączone.' });
  }
  const raw = (req.body as any)?.projectIds;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'Podaj tablicę projectIds (co najmniej jeden projekt).' });
  }
  const projectIds = raw.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0);
  if (projectIds.length === 0) return res.status(400).json({ error: 'Nieprawidłowe identyfikatory projektów.' });
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const result = appendProductionProjectsToBundle(bundle, projectIds);
    if (result.addedProjectIds.length === 0) {
      return res.status(400).json({
        error: 'Nie dodano żadnego projektu (wszystkie już w scenariuszu lub brak w produkcji).',
        ...result,
      });
    }
    const labels = result.addedProjectIds
      .map((pid) => {
        const p = (bundle.projects || []).find((x: any) => Number(x.id) === pid) as any;
        return p ? `„${p.name}” (#${pid})` : `#${pid}`;
      })
      .join(', ');
    pushScenarioAudit(bundle, {
      author: resolveScenarioActor(req),
      note_type: 'auto',
      note: `Dodano do scenariusza projekty z wersji Capacity: ${labels}.`,
    });
    try {
      db.prepare(`UPDATE scenarios SET snapshot = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(bundle), id);
    } catch {
      db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(JSON.stringify(bundle), id);
    }
    saveDb();
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd dodawania projektów do scenariusza' });
  }
});

scenariosRouter.post('/:id/apply-to-production', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(id) as { snapshot: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const challengePhrase = String((req.body as any)?.challengePhrase ?? '').trim();
  const deployToken = String((req.body as any)?.deployToken ?? '').trim();
  if (!deployToken || verifyDeployProof(deployToken, id, challengePhrase).ok !== true) {
    return res.status(400).json({
      error:
        'Nieprawidłowy lub wygasły kod potwierdzenia. Kliknij ponownie „Wgraj do produkcji”, pobierz nowy kod i wpisz go dokładnie (wielkość liter ma znaczenie).',
    });
  }
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    applyScenarioBundleToProduction(bundle, id);
    res.json({ ok: true, message: 'Dane produkcyjne (projekty, części, operacje, wolumeny, dni robocze) zastąpione zawartością scenariusza.' });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd wgrywania scenariusza' });
  }
});

/** Wgranie wybranych projektów (całość) lub wybranych detali do produkcji — bez zastępowania całej bazy i bez zmiany `working_days`. */
scenariosRouter.post('/:id/apply-subset-to-production', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(id) as { snapshot: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const challengePhrase = String((req.body as any)?.challengePhrase ?? '').trim();
  const deployToken = String((req.body as any)?.deployToken ?? '').trim();
  if (!deployToken || verifyDeployProof(deployToken, id, challengePhrase).ok !== true) {
    return res.status(400).json({
      error:
        'Nieprawidłowy lub wygasły kod potwierdzenia. Kliknij ponownie „Wgraj…”, pobierz nowy kod i wpisz go dokładnie (wielkość liter ma znaczenie).',
    });
  }
  const rawProjectIds = (req.body as any)?.projectIds;
  const rawPartIds = (req.body as any)?.partIds;
  if (!Array.isArray(rawProjectIds) || rawProjectIds.length === 0) {
    return res.status(400).json({ error: 'Podaj tablicę projectIds (co najmniej jeden projekt).' });
  }
  const projectIds = rawProjectIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0);
  if (projectIds.length === 0) return res.status(400).json({ error: 'Nieprawidłowe identyfikatory projektów.' });
  const partIds =
    Array.isArray(rawPartIds) && rawPartIds.length > 0
      ? rawPartIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)
      : null;
  try {
    const bundle = parseScenarioSnapshotJson(row.snapshot);
    const result = applyScenarioBundleSubsetToProduction(bundle, { projectIds, partIds }, id);
    const msg =
      result.mode === 'parts'
        ? `Wgrano ${result.partsTouched} detali (części) do produkcji w ramach ${result.projectsTouched} projektów (bez zmiany dni roboczych).`
        : `Wgrano ${result.projectsTouched} projektów (${result.partsTouched} części łącznie) do produkcji (bez zmiany dni roboczych).`;
    res.json({ ok: true, message: msg, ...result });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Błąd częściowego wgrywania' });
  }
});

/** Filtry historii zmian wyłącznie dla danego scenariusza (dane z snapshotu + maszyny z produkcji). */
scenariosRouter.get('/:id/history/filters', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(id) as { snapshot: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  let bundle;
  try {
    bundle = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return res.status(500).json({ error: 'Niepoprawny snapshot' });
  }
  const refMode = loadReferenceDisplayMode();
  const projects = (bundle.projects || []).map((p: any) => ({
    id: Number(p.id),
    client: String(p.client ?? ''),
    name: String(p.name ?? ''),
  }));
  const clients = [...new Set(projects.map((p) => normalizeClientName(p.client)).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'pl')
  );
  const machines = db.prepare('SELECT id, sap_number, internal_number, type FROM machines ORDER BY sap_number, internal_number').all() as {
    id: number;
    sap_number: string | null;
    internal_number: string | null;
    type: string | null;
  }[];
  const details: { id: number; label: string }[] = [];
  for (const pt of bundle.parts || []) {
    const pd = (bundle.part_designations || []).find((d: any) => Number(d.id) === Number(pt.designation_id));
    const label = formatDetailSapAliasLabel(
      {
        sap_number: pd?.sap_number ?? null,
        alias: pd?.alias ?? null,
        free_text: pd?.free_text ?? null,
        designation: pt.designation ?? null,
        id: pt.id,
      },
      refMode
    );
    details.push({ id: Number(pt.id), label });
  }
  details.sort((a, b) => a.label.localeCompare(b.label, 'pl'));
  const authors = [
    ...new Set((bundle.audit_log || []).map((e) => String(e.author ?? '').trim()).filter(Boolean)),
  ].sort();
  res.json({ projects, clients, machines, details, authors });
});

/** Historia zmian zapisana w snapshotcie scenariusza (audit_log), niezależnie od produkcyjnej project_notes. */
scenariosRouter.get('/:id/history', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(id) as { snapshot: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  let bundle;
  try {
    bundle = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return res.status(500).json({ error: 'Niepoprawny snapshot' });
  }
  const refMode = loadReferenceDisplayMode();
  const projectIds = parseIdList(req.query.projectId, req.query.projectIds);
  const machineIds = parseIdList(req.query.machineId, req.query.machineIds);
  const partIds = parseIdList(req.query.partId, req.query.partIds);
  const clients = parseClientFilterQuery(req.query.client, req.query.clients);
  const authors = parseCsvQueryParamSingleOrMulti(req.query.author, req.query.authors);
  const text = String(req.query.text ?? '').trim();

  const projectsById = new Map((bundle.projects || []).map((p: any) => [Number(p.id), p]));
  let rows = [...(bundle.audit_log || [])].sort((a, b) => Number(b.id) - Number(a.id));
  if (projectIds.length === 1) {
    rows = rows.filter((r) => Number(r.project_id) === projectIds[0]);
  } else if (projectIds.length > 1) {
    const set = new Set(projectIds);
    rows = rows.filter((r) => set.has(Number(r.project_id)));
  }
  if (machineIds.length === 1) {
    rows = rows.filter((r) => Number(r.machine_id) === machineIds[0]);
  } else if (machineIds.length > 1) {
    const set = new Set(machineIds);
    rows = rows.filter((r) => set.has(Number(r.machine_id)));
  }
  if (partIds.length === 1) {
    rows = rows.filter((r) => Number(r.part_id) === partIds[0]);
  } else if (partIds.length > 1) {
    const set = new Set(partIds);
    rows = rows.filter((r) => set.has(Number(r.part_id)));
  }
  if (clients.length === 1) {
    rows = rows.filter((r) => {
      const p = projectsById.get(Number(r.project_id));
      return p && clientNamesMatch((p as any).client, clients[0]);
    });
  } else if (clients.length > 1) {
    const set = new Set(clients);
    rows = rows.filter((r) => {
      const p = projectsById.get(Number(r.project_id));
      return p && set.has(normalizeClientName((p as any).client));
    });
  }
  if (authors.length === 1) {
    rows = rows.filter((r) => String(r.author ?? '') === authors[0]);
  } else if (authors.length > 1) {
    const set = new Set(authors);
    rows = rows.filter((r) => set.has(String(r.author ?? '')));
  }
  if (text) {
    const q = text.toLowerCase();
    rows = rows.filter((r) => {
      const p = projectsById.get(Number(r.project_id));
      const pname = p ? String((p as any).name ?? '').toLowerCase() : '';
      const pclient = p ? String((p as any).client ?? '').toLowerCase() : '';
      return (
        String(r.note ?? '')
          .toLowerCase()
          .includes(q) ||
        String(r.author ?? '')
          .toLowerCase()
          .includes(q) ||
        pname.includes(q) ||
        pclient.includes(q)
      );
    });
  }
  rows = rows.slice(0, 2000);

  const machineById = new Map(
    (db.prepare('SELECT id, sap_number, internal_number FROM machines').all() as any[]).map((m) => [Number(m.id), m])
  );
  const partRow = (pid: number) => (bundle.parts || []).find((p: any) => Number(p.id) === pid);
  const desById = new Map((bundle.part_designations || []).map((d: any) => [Number(d.id), d]));

  res.json(
    rows.map((r) => {
      const mrow = r.machine_id != null ? machineById.get(Number(r.machine_id)) : undefined;
      const machineSap = String(mrow?.sap_number ?? '').trim();
      const machineInternal = String(mrow?.internal_number ?? '').trim();
      let machineLabel = '';
      if (machineSap && machineInternal) machineLabel = `${machineSap} (${machineInternal})`;
      else if (machineSap) machineLabel = machineSap;
      else if (machineInternal) machineLabel = machineInternal;
      else if (r.machine_id != null) machineLabel = `maszyna #${r.machine_id}`;

      const pt = r.part_id != null ? partRow(Number(r.part_id)) : undefined;
      const pd = pt?.designation_id != null ? desById.get(Number(pt.designation_id)) : undefined;
      let detailLabel = '';
      if (pt) {
        detailLabel = formatDetailSapAliasLabel(
          {
            sap_number: pd?.sap_number ?? null,
            alias: pd?.alias ?? null,
            free_text: pd?.free_text ?? null,
            designation: pt.designation ?? null,
            id: pt.id,
          },
          refMode
        );
      }

      const proj = r.project_id != null ? projectsById.get(Number(r.project_id)) : undefined;
      return {
        id: r.id,
        project_id: r.project_id ?? null,
        note_date: r.note_date,
        author: r.author,
        note: r.note,
        note_type: r.note_type,
        machine_id: r.machine_id ?? null,
        part_id: r.part_id ?? null,
        operation_id: r.operation_id ?? null,
        client: proj ? String((proj as any).client ?? '') : '',
        project_name: proj ? String((proj as any).name ?? '') : '',
        machine_label: machineLabel,
        detail_label: detailLabel,
      };
    })
  );
});

scenariosRouter.post('/:id/archive', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  try {
    db.prepare(`UPDATE scenarios SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  } catch (e: any) {
    if (!String(e?.message || '').includes('no such column')) throw e;
    return res.status(500).json({ error: 'Baza bez kolumny archiwum — uruchom migracje.' });
  }
  saveDb();
  res.json({ ok: true });
});

scenariosRouter.post('/:id/unarchive', (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Not found' });
  try {
    db.prepare(`UPDATE scenarios SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  } catch (e: any) {
    if (!String(e?.message || '').includes('no such column')) throw e;
    return res.status(500).json({ error: 'Baza bez kolumny archiwum — uruchom migracje.' });
  }
  saveDb();
  res.json({ ok: true });
});

scenariosRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  let snapshot: any;
  try {
    snapshot = parseScenarioSnapshotJson(row.snapshot);
  } catch {
    return res.status(500).json({ error: 'Niepoprawny zapis scenariusza (snapshot)' });
  }
  res.json({
    id: row.id,
    name: row.name,
    scenario_scope: row.scenario_scope != null ? String(row.scenario_scope) : '',
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    source_scenario_id: row.source_scenario_id != null ? Number(row.source_scenario_id) : null,
    source_call_off_comparison_id:
      row.source_call_off_comparison_id != null && Number(row.source_call_off_comparison_id) > 0
        ? Number(row.source_call_off_comparison_id)
        : null,
    archived_at: row.archived_at != null && String(row.archived_at).trim() !== '' ? String(row.archived_at) : null,
    snapshot,
  });
});

scenariosRouter.post('/', (req, res) => {
  const body = req.body as any;
  const name = String(body?.name ?? '').trim();
  const scenario_scope = String(body?.scenario_scope ?? body?.scenarioScope ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Nazwa scenariusza jest wymagana' });
  if (!scenario_scope) return res.status(400).json({ error: 'Zakres scenariusza jest wymagany (pole tekstowe).' });
  const rawSource = body.sourceScenarioId != null && body.sourceScenarioId !== '' ? Number(body.sourceScenarioId) : null;
  const sourceScenarioId = rawSource != null && Number.isFinite(rawSource) && rawSource > 0 ? rawSource : null;
  const rawCallOff =
    body.sourceCallOffComparisonId != null && body.sourceCallOffComparisonId !== ''
      ? Number(body.sourceCallOffComparisonId)
      : null;
  const sourceCallOffComparisonId =
    rawCallOff != null && Number.isFinite(rawCallOff) && rawCallOff > 0 ? rawCallOff : null;

  if (sourceCallOffComparisonId != null) {
    const cmp = db.prepare('SELECT id FROM call_off_comparisons WHERE id = ?').get(sourceCallOffComparisonId);
    if (!cmp) return res.status(400).json({ error: 'Nie znaleziono porównania Call off' });
    const stats = db
      .prepare('SELECT COUNT(*) AS c FROM call_off_volumes WHERE comparison_id = ?')
      .get(sourceCallOffComparisonId) as { c: number };
    if (!stats?.c) return res.status(400).json({ error: 'Wybrane porównanie Call off nie ma zaimportowanych wolumenów.' });
  }

  let bundleJson: string;
  try {
    if (sourceScenarioId != null) {
      const parent = db.prepare('SELECT snapshot FROM scenarios WHERE id = ?').get(sourceScenarioId) as { snapshot: string } | undefined;
      if (!parent) return res.status(400).json({ error: 'Nie znaleziono scenariusza źródłowego' });
      const parsed = parseScenarioSnapshotJson(parent.snapshot);
      bundleJson = JSON.stringify(cloneScenarioBundle(parsed));
    } else {
      bundleJson = JSON.stringify(exportLiveScenarioBundle());
    }
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Błąd budowania scenariusza' });
  }

  try {
    const insert = db.prepare(
      `INSERT INTO scenarios (name, snapshot, source_scenario_id, source_call_off_comparison_id, updated_at, scenario_scope) VALUES (?, ?, ?, ?, datetime('now'), ?)`
    );
    const r = insert.run(name, bundleJson, sourceScenarioId, sourceCallOffComparisonId, scenario_scope);
    const newId = Number(r.lastInsertRowid);
    const row = db
      .prepare(
        'SELECT id, name, created_at, source_scenario_id, source_call_off_comparison_id, updated_at, scenario_scope FROM scenarios WHERE id = ?'
      )
      .get(newId) as any;
    saveDb();
    res.status(201).json(row);
  } catch (e: any) {
    if (String(e?.message || '').includes('no such column')) {
      try {
        const insert = db.prepare(
          `INSERT INTO scenarios (name, snapshot, source_scenario_id, updated_at, scenario_scope) VALUES (?, ?, ?, datetime('now'), ?)`
        );
        const r = insert.run(name, bundleJson, sourceScenarioId, scenario_scope);
        const newId = Number(r.lastInsertRowid);
        const row = db
          .prepare('SELECT id, name, created_at, source_scenario_id, updated_at, scenario_scope FROM scenarios WHERE id = ?')
          .get(newId) as any;
        saveDb();
        return res.status(201).json({ ...row, source_call_off_comparison_id: null });
      } catch {
        /* fall through */
      }
    }
    if (String(e?.message || '').includes('no such column')) {
      try {
        const insert = db.prepare(
          'INSERT INTO scenarios (name, snapshot, source_scenario_id, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
        );
        const ins = insert.run(name, bundleJson, sourceScenarioId);
        const newId = Number(ins.lastInsertRowid);
        const row = db.prepare('SELECT id, name, created_at, source_scenario_id, updated_at FROM scenarios WHERE id = ?').get(newId) as any;
        saveDb();
        return res.status(201).json({ ...row, scenario_scope });
      } catch {
        const ins = db.prepare('INSERT INTO scenarios (name, snapshot) VALUES (?, ?)').run(name, bundleJson);
        const newId = Number(ins.lastInsertRowid);
        const row = db.prepare('SELECT id, name, created_at FROM scenarios WHERE id = ?').get(newId) as any;
        saveDb();
        return res.status(201).json({ ...row, source_scenario_id: null, updated_at: null, scenario_scope });
      }
    }
    return res.status(500).json({ error: e?.message || 'Błąd zapisu' });
  }
});

scenariosRouter.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const body = req.body as any;
  const name = body.name != null ? String(body.name).trim() : null;
  let snapshotStr: string | null = null;
  if (body.snapshot != null && typeof body.snapshot === 'object') {
    snapshotStr = JSON.stringify(body.snapshot);
  }
  let scenarioScopeCol: string | undefined;
  if (body.scenario_scope !== undefined || body.scenarioScope !== undefined) {
    scenarioScopeCol = String(body.scenario_scope ?? body.scenarioScope ?? '').trim();
    if (!scenarioScopeCol) return res.status(400).json({ error: 'Zakres scenariusza nie może być pusty.' });
  }
  try {
    if (scenarioScopeCol != null && name != null && snapshotStr != null) {
      db.prepare(
        `UPDATE scenarios SET name = ?, snapshot = ?, scenario_scope = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(name, snapshotStr, scenarioScopeCol, id);
    } else if (scenarioScopeCol != null && name != null) {
      db.prepare(`UPDATE scenarios SET name = ?, scenario_scope = ?, updated_at = datetime('now') WHERE id = ?`).run(name, scenarioScopeCol, id);
    } else if (scenarioScopeCol != null && snapshotStr != null) {
      db.prepare(`UPDATE scenarios SET snapshot = ?, scenario_scope = ?, updated_at = datetime('now') WHERE id = ?`).run(snapshotStr, scenarioScopeCol, id);
    } else if (scenarioScopeCol != null) {
      db.prepare(`UPDATE scenarios SET scenario_scope = ?, updated_at = datetime('now') WHERE id = ?`).run(scenarioScopeCol, id);
    } else if (name != null && snapshotStr != null) {
      db.prepare('UPDATE scenarios SET name = ?, snapshot = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, snapshotStr, id);
    } else if (snapshotStr != null) {
      db.prepare('UPDATE scenarios SET snapshot = ?, updated_at = datetime(\'now\') WHERE id = ?').run(snapshotStr, id);
    } else if (name != null) {
      db.prepare('UPDATE scenarios SET name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(name, id);
    }
  } catch {
    if (scenarioScopeCol != null && name != null && snapshotStr != null) {
      db.prepare('UPDATE scenarios SET name = ?, snapshot = ? WHERE id = ?').run(name, snapshotStr, id);
    } else if (name != null && snapshotStr != null) db.prepare('UPDATE scenarios SET name = ?, snapshot = ? WHERE id = ?').run(name, snapshotStr, id);
    else if (snapshotStr != null) db.prepare('UPDATE scenarios SET snapshot = ? WHERE id = ?').run(snapshotStr, id);
    else if (name != null) db.prepare('UPDATE scenarios SET name = ? WHERE id = ?').run(name, id);
  }
  saveDb();
  try {
    const row = db
      .prepare('SELECT id, name, created_at, source_scenario_id, updated_at, scenario_scope FROM scenarios WHERE id = ?')
      .get(id) as any;
    res.json(row ?? { id, name: null, created_at: null, source_scenario_id: null, updated_at: null, scenario_scope: '' });
  } catch {
    const row = db.prepare('SELECT id, name, created_at, source_scenario_id, updated_at FROM scenarios WHERE id = ?').get(id) as any;
    res.json(row ?? { id, name: null, created_at: null, source_scenario_id: null, updated_at: null });
  }
});

scenariosRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    db.prepare('UPDATE scenarios SET source_scenario_id = NULL WHERE source_scenario_id = ?').run(id);
  } catch {
    /* brak kolumny */
  }
  const r = db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  saveDb();
  res.status(204).send();
});
