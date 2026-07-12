/**
 * @module routes/constraintRoutes
 * @description Constraint control-plane router, mounted at `/api/constraints`
 * behind `requireAuth`. Manages engine-agnostic data-quality constraints
 * (NOT NULL / UNIQUE / ENUM / CHECK / FK) enforced by the fabric at write time.
 */

import { Router } from 'express';
import { listConstraints, createConstraint } from '../controllers/constraintController';

const router = Router();

router.get('/', listConstraints); // GET /api/constraints — list constraints for the caller's tenant
router.post('/', createConstraint); // POST /api/constraints — create/replace a constraint spec for a schema/table

export default router;
