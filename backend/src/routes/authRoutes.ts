/**
 * @module routes/authRoutes
 * @description Authentication router, mounted at `/api/auth` (no auth
 * middleware required — this is the entry point for obtaining a bearer token).
 */

import { Router } from 'express';
import * as authController from '../controllers/authController';

const router = Router();

router.post('/login', authController.login); // POST /api/auth/login — authenticate with username/password, issue a bearer token
router.post('/token', authController.refreshToken); // POST /api/auth/token — exchange the current session for a tenant-scoped token

export default router;
