/**
 * @module controllers/constraintController
 * @description Constraint control plane. Constraints are engine-agnostic (NOT NULL / UNIQUE /
 * ENUM / CHECK / FK) and enforced by the fabric on non-SQL engines at write time.
 */

import { Request, Response } from 'express';
import { ConstraintService, ConstraintSpec } from '../modules/query-engine/constraint.service';

/**
 * List all data-quality constraints registered for the caller's tenant.
 *
 * @param req - Express request. Reads the tenant from `(req as any).user?.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of constraint records from `ConstraintService.list`.
 * @throws Responds 500 `{ error }` if the lookup fails.
 */
export const listConstraints = async (req: Request, res: Response) => {
  try {
    res.json(await ConstraintService.list((req as any).user?.tenant_id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create or replace the constraint spec (column rules + check expressions) for
 * a schema/table pair. The spec is enforced by the fabric at write time for
 * engines that lack native constraint support (e.g. MongoDB, remote sources).
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   Body fields: `schema` (string, required), `table` (string, required),
 *   `columns` (array of per-column rules, e.g. NOT NULL/UNIQUE/ENUM/FK — optional
 *   but at least one of `columns`/`checks` must be non-empty), `checks` (array of
 *   CHECK expressions, optional).
 * @param res - Express response.
 * @returns 201 with the upserted constraint record from `ConstraintService.upsert`
 *   (recorded with source `'API'`).
 * @throws Responds 400 `{ error }` when `schema`/`table` are missing, or when both
 *   `columns` and `checks` are empty; 500 `{ error }` on unexpected failures.
 */
export const createConstraint = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const { schema, table } = req.body || {};
    const spec: ConstraintSpec = { columns: req.body?.columns || [], checks: req.body?.checks || [] };
    if (!schema || !table) return res.status(400).json({ error: 'schema and table are required' });
    if (!spec.columns.length && !spec.checks.length) return res.status(400).json({ error: 'provide at least one column rule or check' });
    res.status(201).json(await ConstraintService.upsert(tenantId, schema, table, spec, 'API'));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
