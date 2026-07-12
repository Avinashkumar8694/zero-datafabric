/**
 * @module controllers/policyController
 * @description Access-policy control plane. Policies are engine-agnostic (row predicate +
 * column masking) and enforced by the fabric on non-RLS engines (Mongo/ES/remote), and
 * can also be exercised on SQL engines via the `x-act-as-role` "view as" mechanism.
 */

import { Request, Response } from 'express';
import { PolicyService, AccessPolicy } from '../modules/security/policy.service';

/**
 * List all row-filter/column-masking access policies registered for the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 * @param res - Express response.
 * @returns 200 with the array of policy records from `PolicyService.listPolicies`.
 * @throws Responds 500 `{ error }` if the lookup fails.
 */
export const listPolicies = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    res.json(await PolicyService.listPolicies(tenantId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Create or replace an access policy for a schema/table pair, made up of a
 * row filter predicate and/or column-masking rules.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   Body is an `AccessPolicy`: `name` (string, required), `schema` (string, required),
 *   `table` (string, required), `rowFilter` (array of predicate rules — policy must
 *   define this or `masking`), `masking` (array of column-masking rules).
 * @param res - Express response.
 * @returns 201 with the upserted policy record from `PolicyService.upsertPolicy`
 *   (recorded with source `'API'`).
 * @throws Responds 400 `{ error }` when `name`/`schema`/`table` are missing, or when
 *   neither `rowFilter` nor `masking` has any entries; 500 `{ error }` on unexpected failures.
 */
export const createPolicy = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const p = req.body as AccessPolicy;
    if (!p?.name || !p?.schema || !p?.table) {
      return res.status(400).json({ error: 'name, schema and table are required' });
    }
    if (!p.rowFilter?.length && !p.masking?.length) {
      return res.status(400).json({ error: 'a policy needs at least a rowFilter or masking rule' });
    }
    res.status(201).json(await PolicyService.upsertPolicy(tenantId, p, 'API'));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Delete an access policy by id, scoped to the caller's tenant.
 *
 * @param req - Express request. Reads tenant from `(req as any).user?.tenant_id`.
 *   `req.params.id` is the policy id to delete.
 * @param res - Express response.
 * @returns 200 `{ status: 'DELETED', id }` when the policy existed and was removed.
 * @throws Responds 404 `{ error: 'policy not found' }` when no matching policy exists
 *   for the tenant; 500 `{ error }` on unexpected failures.
 */
export const deletePolicy = async (req: Request, res: Response) => {
  try {
    const tenantId = (req as any).user?.tenant_id;
    const id = String(req.params.id);
    const ok = await PolicyService.deletePolicy(tenantId, id);
    if (!ok) return res.status(404).json({ error: 'policy not found' });
    res.json({ status: 'DELETED', id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
