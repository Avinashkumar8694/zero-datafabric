/**
 * @module routes/grantRoutes
 * @description Grant control-plane router, mounted at `/api/grants` behind
 * `requireAuth`. Manages engine-agnostic table privileges (SELECT/INSERT/
 * UPDATE/DELETE per role) enforced by the fabric on non-SQL engines.
 */

import { Router } from 'express';
import { listGrants, createGrant } from '../controllers/grantController';

const router = Router();
router.get('/', listGrants); // GET /api/grants — list grants for the caller's tenant
router.post('/', createGrant); // POST /api/grants — create/replace role privileges on a schema/table
export default router;
