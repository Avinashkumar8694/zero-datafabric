/**
 * @module routes/policyRoutes
 * @description Access-policy control-plane router, mounted at `/api/policies`
 * behind `requireAuth`. Manages engine-agnostic row-filter and column-masking
 * policies enforced by the fabric on non-RLS engines.
 */

import { Router } from 'express';
import { listPolicies, createPolicy, deletePolicy } from '../controllers/policyController';

const router = Router();

router.get('/', listPolicies); // GET /api/policies — list access policies for the caller's tenant
router.post('/', createPolicy); // POST /api/policies — create/replace an access policy for a schema/table
router.delete('/:id', deletePolicy); // DELETE /api/policies/:id — delete an access policy

export default router;
