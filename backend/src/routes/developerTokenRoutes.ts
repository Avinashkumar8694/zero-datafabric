/**
 * @module routes/developerTokenRoutes
 * @description Developer API token management, mounted at `/api/developer/tokens`.
 * Requires a user session (JWT); API tokens themselves are rejected here.
 */

import { Router, Request, Response } from 'express';
import { ApiTokenService, TokenError, TOKEN_SCOPES } from '../modules/auth/api-token.service';

const router = Router();

const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try {
    if ((req as any).user?.auth_type === 'api_token') return res.status(403).json({ error: 'A user session is required to manage tokens', code: 'TOKEN_FROM_TOKEN' });
    await fn(req, res);
  } catch (e: any) {
    if (e instanceof TokenError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[DeveloperTokens]', e.message);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  }
};

router.get('/scopes', wrap(async (_req, res) => { res.json({ scopes: TOKEN_SCOPES }); })); // GET /api/developer/tokens/scopes — grantable scopes
router.get('/', wrap(async (req, res) => { res.json(await ApiTokenService.list((req as any).user)); })); // GET /api/developer/tokens — list my tokens (no secrets)
router.post('/', wrap(async (req, res) => { res.status(201).json(await ApiTokenService.create((req as any).user, req.body)); })); // POST /api/developer/tokens — mint a token (secret shown once)
router.delete('/:id', wrap(async (req, res) => { await ApiTokenService.revoke((req as any).user, String(req.params.id)); res.status(204).end(); })); // DELETE /api/developer/tokens/:id — revoke

export default router;
