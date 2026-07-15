/**
 * @module routes/authRoutes
 * @description Authentication router, mounted at `/api/auth` (no auth
 * middleware required — this is the entry point for obtaining a bearer token).
 */

import { Router } from 'express';
import * as authController from '../controllers/authController';

const router = Router();

const requireAuth = (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
};

router.post('/login', authController.login); // POST /api/auth/login — authenticate with username/password, issue a bearer token
router.post('/token', authController.refreshToken); // POST /api/auth/token — exchange the current session for a tenant-scoped token
router.post('/timezone', requireAuth, authController.saveTimezone); // POST /api/auth/timezone - update user's timezone

// SSO Routes
router.get('/sso', authController.sso); // GET /api/auth/sso — redirect to Identity Server
router.get('/sso/callback', authController.ssoCallback); // GET /api/auth/sso/callback — handle OIDC code exchange and sign user in

export default router;
