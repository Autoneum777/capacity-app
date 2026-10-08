import type { NextFunction, Request, Response } from 'express';
import { hasPermission } from './permissions.js';
import { db } from '../db/connection.js';
import { isAuthEnforced } from '../middleware/auth.js';

export const CONFIDENTIAL_SCENARIO_PERMISSION = 'scenarios.view_confidential';

export function canViewConfidentialScenarios(req: Request): boolean {
  if (!isAuthEnforced()) return true;
  return hasPermission(req.user?.permissions, CONFIDENTIAL_SCENARIO_PERMISSION);
}

/** true = scenariusz jest poufny, a ta sesja nie ma do niego wglądu. */
export function isScenarioHiddenFromRequest(req: Request, scenarioId: number): boolean {
  if (!Number.isFinite(scenarioId) || scenarioId <= 0) return false;
  if (canViewConfidentialScenarios(req)) return false;
  try {
    const row = db.prepare('SELECT is_confidential FROM scenarios WHERE id = ?').get(scenarioId) as
      | { is_confidential?: number | null }
      | undefined;
    if (!row) return false;
    return Number(row.is_confidential) === 1;
  } catch {
    return false;
  }
}

export function blockHiddenScenarioAccess(req: Request, res: Response, next: NextFunction): void {
  const fromQuery = req.query?.scenarioId;
  const fromBody =
    req.body && typeof req.body === 'object' ? (req.body as { scenarioId?: unknown }).scenarioId : undefined;
  const id = Number(fromQuery ?? fromBody);
  if (Number.isFinite(id) && id > 0 && isScenarioHiddenFromRequest(req, id)) {
    res.status(404).json({ error: 'Scenariusz nie znaleziony' });
    return;
  }
  next();
}
