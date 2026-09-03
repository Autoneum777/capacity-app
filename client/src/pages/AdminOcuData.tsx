import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../context/I18nContext';
import {
  DEFAULT_OCU_COLUMN_LETTERS,
  loadOcuColumnLettersFromStorage,
  normalizeExcelLetter,
  OCU_COLUMN_FIELD_META,
  saveOcuColumnLettersToStorage,
  shiftOcuColumnsAfterLetter,
  type OcuColumnLetters,
} from '../utils/ocuColumnMapping';

const panelStyle: React.CSSProperties = {
  background: 'white',
  borderRadius: 8,
  padding: '1.25rem 1.5rem',
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  border: '1px solid #eee',
  maxWidth: 920,
};

const fileBoxStyle: React.CSSProperties = {
  ...panelStyle,
  marginBottom: '1rem',
};

type OcuStats = {
  pivot_rows: number;
  filled_ab: number;
  filled_x: number;
  filled_ac: number;
  filled_ad: number;
  filled_ae: number;
  filled_s1619: number;
  filled_s2102_large: number;
  filled_s2102_small: number;
  unmatched_sonar: number;
  unmatched_erp_in_db: number;
  unmatched_routing: number;
  routing_finished_goods: number;
};

type HeaderPreview = { letter: string; header: string; col1: number };

const btnSecondary: React.CSSProperties = {
  padding: '0.4rem 0.75rem',
  background: '#eceff1',
  color: '#37474f',
  border: '1px solid #cfd8dc',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
};

export default function AdminOcuData() {
  const { t, te } = useI18n();
  const { hasPermission } = useAuth();
  const canGenerate = hasPermission('admin_ocu.edit');
  const [transitionFile, setTransitionFile] = useState<File | null>(null);
  const [katowiceFile, setKatowiceFile] = useState<File | null>(null);
  const [routingFile, setRoutingFile] = useState<File | null>(null);
  const [katowicePassword, setKatowicePassword] = useState('');
  const katowicePasswordRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState<OcuStats | null>(null);
  const [columnLetters, setColumnLetters] = useState<OcuColumnLetters>(() => loadOcuColumnLettersFromStorage());
  const [headers, setHeaders] = useState<HeaderPreview[]>([]);
  const [headerRowNum, setHeaderRowNum] = useState<number | null>(null);
  const [showRoutingCols, setShowRoutingCols] = useState(false);

  const ready = Boolean(transitionFile && katowiceFile && routingFile);
  const needsPasswordHint =
    /hasł|password|zaszyfr|encrypt|decrypt/i.test(error) || Boolean(katowicePassword);

  const headerByLetter = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of headers) m.set(h.letter.toUpperCase(), h.header);
    return m;
  }, [headers]);

  const readFields = OCU_COLUMN_FIELD_META.filter((f) => f.role === 'read');
  const capacityFields = OCU_COLUMN_FIELD_META.filter((f) => f.role === 'write_capacity');
  const routingFields = OCU_COLUMN_FIELD_META.filter((f) => f.role === 'write_routing');

  const resolvePwd = () => {
    const pwdFromDom = String(katowicePasswordRef.current?.value ?? '').trim();
    const pwd = pwdFromDom || katowicePassword.trim();
    if (pwd && pwd !== katowicePassword) setKatowicePassword(pwd);
    return pwd;
  };

  const persistLetters = (next: OcuColumnLetters) => {
    setColumnLetters(next);
    saveOcuColumnLettersToStorage(next);
  };

  const onLetterChange = (key: keyof OcuColumnLetters, raw: string) => {
    const upper = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
    persistLetters({ ...columnLetters, [key]: upper });
  };

  const onLoadHeaders = async () => {
    setError('');
    if (!katowiceFile) {
      setError(t('admin.ocuDataNeedKatowice'));
      return;
    }
    const pwd = resolvePwd();
    setPreviewBusy(true);
    try {
      const result = await api.admin.previewOcuHeaders(katowiceFile, {
        katowicePassword: pwd || undefined,
        columnMapping: columnLetters,
      });
      setHeaders(result.headers ?? []);
      setHeaderRowNum(result.headerRowNum ?? null);
      if (result.suggested && typeof result.suggested === 'object') {
        const next = { ...columnLetters };
        for (const key of Object.keys(DEFAULT_OCU_COLUMN_LETTERS) as (keyof OcuColumnLetters)[]) {
          const norm = normalizeExcelLetter(String(result.suggested[key] ?? ''));
          if (norm) next[key] = norm;
        }
        persistLetters(next);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      setError(te(msg) || t('admin.ocuDataPreviewFailed'));
    } finally {
      setPreviewBusy(false);
    }
  };

  const onShiftAfterS = () => {
    persistLetters(shiftOcuColumnsAfterLetter(columnLetters, columnLetters.sonarCode || 'S', 1));
  };

  const onResetDefaults = () => {
    persistLetters({ ...DEFAULT_OCU_COLUMN_LETTERS });
  };

  const onGenerate = async () => {
    setError('');
    setStats(null);
    if (!transitionFile) {
      setError(t('admin.ocuDataNeedTransition'));
      return;
    }
    if (!katowiceFile) {
      setError(t('admin.ocuDataNeedKatowice'));
      return;
    }
    if (!routingFile) {
      setError(t('admin.ocuDataNeedRouting'));
      return;
    }
    const pwd = resolvePwd();
    setBusy(true);
    try {
      const result = await api.admin.generateOcuData(transitionFile, katowiceFile, routingFile, {
        katowicePassword: pwd || undefined,
        columnMapping: columnLetters,
      });
      setStats(result.stats);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      setError(te(msg) || t('admin.ocuDataGenerateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const renderFieldRows = (fields: typeof OCU_COLUMN_FIELD_META) =>
    fields.map((f) => {
      const letter = columnLetters[f.key] || '';
      const fileHeader = letter ? headerByLetter.get(letter.toUpperCase()) : undefined;
      const label = fileHeader || f.headerHint;
      return (
        <tr key={f.key}>
          <td style={{ padding: '6px 8px', verticalAlign: 'middle', fontSize: 13 }}>
            <div style={{ fontWeight: 600, color: '#263238' }}>{label}</div>
            {fileHeader && fileHeader !== f.headerHint ? (
              <div style={{ fontSize: 11, color: '#90a4ae', marginTop: 2 }}>{f.headerHint}</div>
            ) : null}
          </td>
          <td style={{ padding: '6px 8px', width: 88 }}>
            <input
              type="text"
              value={letter}
              onChange={(e) => onLetterChange(f.key, e.target.value)}
              maxLength={3}
              spellCheck={false}
              style={{
                width: 64,
                padding: '6px 8px',
                border: '1px solid #cfd8dc',
                borderRadius: 4,
                fontFamily: 'ui-monospace, Consolas, monospace',
                textTransform: 'uppercase',
                fontSize: 13,
              }}
            />
          </td>
          <td style={{ padding: '6px 8px', fontSize: 12, color: '#546e7a', maxWidth: 280 }}>
            {fileHeader ? (
              <span title={fileHeader}>{fileHeader}</span>
            ) : headers.length ? (
              <span style={{ color: '#c62828' }}>{t('admin.ocuColHeaderMissing')}</span>
            ) : (
              <span style={{ color: '#b0bec5' }}>—</span>
            )}
          </td>
        </tr>
      );
    });

  return (
    <div>
      <p style={{ marginBottom: '0.75rem' }}>
        <Link to="/administracja" style={{ color: 'var(--cap-green)' }}>
          ← {t('admin.title')}
        </Link>
      </p>
      <h1 style={{ marginTop: 0 }}>{t('admin.ocuData')}</h1>
      <p style={{ color: '#666', marginBottom: '1.25rem', maxWidth: 820 }}>{t('admin.ocuDataIntro')}</p>

      <div style={fileBoxStyle}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{t('admin.ocuDataTransitionTitle')}</strong>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#555' }}>{t('admin.ocuDataTransitionHelp')}</p>
        <input
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setTransitionFile(e.target.files?.[0] ?? null)}
        />
        {transitionFile && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#33691e' }}>
            {transitionFile.name} ({Math.round(transitionFile.size / 1024)} KB)
          </p>
        )}
      </div>

      <div style={fileBoxStyle}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{t('admin.ocuDataKatowiceTitle')}</strong>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#555' }}>{t('admin.ocuDataKatowiceHelp')}</p>
        <input
          type="file"
          accept=".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12"
          onChange={(e) => {
            setKatowiceFile(e.target.files?.[0] ?? null);
            setHeaders([]);
            setHeaderRowNum(null);
          }}
        />
        {katowiceFile && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#33691e' }}>
            {katowiceFile.name} ({(katowiceFile.size / (1024 * 1024)).toFixed(1)} MB)
          </p>
        )}
        <label style={{ display: 'block', marginTop: 12, fontSize: 13, color: '#455a64' }}>
          {t('admin.ocuDataKatowicePasswordLabel')}
          <input
            ref={katowicePasswordRef}
            type="password"
            name="katowicePassword"
            value={katowicePassword}
            onChange={(e) => setKatowicePassword(e.target.value)}
            onInput={(e) => setKatowicePassword((e.target as HTMLInputElement).value)}
            autoComplete="current-password"
            placeholder={t('admin.ocuDataKatowicePasswordPlaceholder')}
            style={{
              display: 'block',
              width: '100%',
              maxWidth: 360,
              marginTop: 6,
              padding: '8px 10px',
              border: needsPasswordHint ? '1px solid #e65100' : '1px solid #cfd8dc',
              borderRadius: 4,
              boxSizing: 'border-box',
            }}
          />
        </label>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: '#78909c' }}>{t('admin.ocuDataKatowicePasswordHelp')}</p>
      </div>

      <div style={fileBoxStyle}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{t('admin.ocuColMappingTitle')}</strong>
        <p style={{ margin: '0 0 12px', fontSize: 13, color: '#555' }}>{t('admin.ocuColMappingHelp')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            style={btnSecondary}
            disabled={!katowiceFile || previewBusy || busy}
            onClick={() => void onLoadHeaders()}
          >
            {previewBusy ? t('admin.ocuColLoadingHeaders') : t('admin.ocuColLoadHeaders')}
          </button>
          <button type="button" style={btnSecondary} disabled={busy} onClick={onShiftAfterS}>
            {t('admin.ocuColShiftAfterS')}
          </button>
          <button type="button" style={btnSecondary} disabled={busy} onClick={onResetDefaults}>
            {t('admin.ocuColResetDefaults')}
          </button>
        </div>
        {headerRowNum != null && (
          <p style={{ margin: '0 0 10px', fontSize: 12, color: '#558b2f' }}>
            {t('admin.ocuColHeadersLoaded', { row: headerRowNum, count: headers.length })}
          </p>
        )}

        <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
          <thead>
            <tr style={{ background: '#f5f5f5', textAlign: 'left', fontSize: 12, color: '#607d8b' }}>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('admin.ocuColColHeader')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('admin.ocuColColLetter')}</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>{t('admin.ocuColColFromFile')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={3} style={{ padding: '10px 8px 4px', fontSize: 12, fontWeight: 700, color: '#455a64' }}>
                {t('admin.ocuColSectionRead')}
              </td>
            </tr>
            {renderFieldRows(readFields)}
            <tr>
              <td colSpan={3} style={{ padding: '14px 8px 4px', fontSize: 12, fontWeight: 700, color: '#455a64' }}>
                {t('admin.ocuColSectionCapacity')}
              </td>
            </tr>
            {renderFieldRows(capacityFields)}
            <tr>
              <td colSpan={3} style={{ padding: '14px 8px 4px' }}>
                <button
                  type="button"
                  onClick={() => setShowRoutingCols((v) => !v)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: 'var(--cap-green)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {showRoutingCols ? '▾ ' : '▸ '}
                  {t('admin.ocuColSectionRouting')}
                </button>
              </td>
            </tr>
            {showRoutingCols ? renderFieldRows(routingFields) : null}
          </tbody>
        </table>
      </div>

      <div style={fileBoxStyle}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{t('admin.ocuDataRoutingTitle')}</strong>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#555' }}>{t('admin.ocuDataRoutingHelp')}</p>
        <input
          type="file"
          accept=".txt,text/plain"
          onChange={(e) => setRoutingFile(e.target.files?.[0] ?? null)}
        />
        {routingFile && (
          <p style={{ margin: '8px 0 0', fontSize: 13, color: '#33691e' }}>
            {routingFile.name} ({(routingFile.size / (1024 * 1024)).toFixed(1)} MB)
          </p>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: '1rem' }}>
        {canGenerate ? (
          <button
            type="button"
            disabled={busy || !ready}
            onClick={() => void onGenerate()}
            style={{
              padding: '0.55rem 1.1rem',
              background: 'var(--cap-green)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              opacity: busy || !ready ? 0.65 : 1,
              cursor: busy || !ready ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? t('admin.ocuDataGenerating') : t('admin.ocuDataGenerate')}
          </button>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: '#c62828' }}>{t('admin.ocuDataNoGeneratePermission')}</p>
        )}
      </div>

      {error && <p style={{ color: 'var(--cap-red)' }}>{error}</p>}

      {stats && (
        <div style={{ ...panelStyle, background: '#f1f8e9', borderColor: '#c5e1a5' }}>
          <strong style={{ display: 'block', marginBottom: 8 }}>{t('admin.ocuDataStatsTitle')}</strong>
          <ul style={{ margin: 0, paddingLeft: '1.2rem', fontSize: 14, color: '#37474f', lineHeight: 1.6 }}>
            <li>{t('admin.ocuDataStatsRows', { count: stats.pivot_rows })}</li>
            <li>{t('admin.ocuDataStatsAb', { count: stats.filled_ab })}</li>
            <li>{t('admin.ocuDataStatsX', { count: stats.filled_x })}</li>
            <li>{t('admin.ocuDataStatsAc', { count: stats.filled_ac })}</li>
            <li>{t('admin.ocuDataStatsAd', { count: stats.filled_ad })}</li>
            <li>{t('admin.ocuDataStatsAe', { count: stats.filled_ae })}</li>
            <li>{t('admin.ocuDataStatsS1619', { count: stats.filled_s1619 })}</li>
            <li>{t('admin.ocuDataStatsS2102Large', { count: stats.filled_s2102_large })}</li>
            <li>{t('admin.ocuDataStatsS2102Small', { count: stats.filled_s2102_small })}</li>
            <li>{t('admin.ocuDataStatsUnmatchedSonar', { count: stats.unmatched_sonar })}</li>
            <li>{t('admin.ocuDataStatsUnmatchedErp', { count: stats.unmatched_erp_in_db })}</li>
            <li>{t('admin.ocuDataStatsUnmatchedRouting', { count: stats.unmatched_routing })}</li>
            <li>{t('admin.ocuDataStatsRoutingFg', { count: stats.routing_finished_goods })}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
