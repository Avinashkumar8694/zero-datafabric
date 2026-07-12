/**
 * @module controllers/grantController
 * @description Grant control plane — engine-agnostic table privileges (SELECT/INSERT/
 * UPDATE/DELETE per role) enforced by the fabric on non-SQL engines that lack native GRANT support.
 */

import { Request, Response } from 'express';
import { GrantService } from '../modules/security/grant.service';

/**
 * List all table-privilege grants registered for the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of grant records from `GrantService.list`.
 * @throws Responds 500 `(error)` if the lookup fails.
 */
export const listGrants = async (req: Request, res: Response) => {
  try {
    res.json(await GrantService.list((req as any).user?.tenant_id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create or replace the set of role privileges granted on a schema/table pair.
 * These grants are what `dataController`/`queryController` mutation paths
 * check (and reject with `ACCESS DENIED`) for engines without native RBAC.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   Body fields: `schema` (string, required), `table` (string, required),
 *   `grants` (non-empty array of `(role, privilege)`-style entries, required).
 * @param res - Express response.
 * @returns 201 with the upserted grant record from `GrantService.upsert`
 *   (recorded with source `'API'`).
 * @throws Responds 400 `(error)` when `schema`/`table` are missing or `grants` is
 *   missing/empty/not an array; 500 `(error)` on unexpected failures.
 */
export const createGrant = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const { schema, table, grants } = req.body || {};
    if (!schema || !table || !Array.isArray(grants) || !grants.length) {
      return res.status(400).json({ error: 'schema, table and a non-empty grants[] are required' });
    }
    res.status(201).json(await GrantService.upsert(tenantId, schema, table, grants, 'API'));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
