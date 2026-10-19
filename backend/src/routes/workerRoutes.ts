/**
 * @module routes/workerRoutes
 * @description Worker-node management for distributed execution, mounted at
 * `/api/admin/workers`. Platform ADMIN JWT only: developer API tokens are never
 * accepted here. Mutations are rate-limited and audited in the service.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { WorkerNodeService, WorkerError } from '../modules/workers/worker-node.service';

const router = Router();

const requireAdminSession = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (!user) return res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
  if (user.internal_role !== 'ADMIN' || user.auth_type === 'api_token') return res.status(403).json({ error: 'Platform admin session required', code: 'FORBIDDEN' });
  next();
};

// 30 mutations / minute / admin (in-memory; enough to stop scripted abuse, the DB constraints stay authoritative).
const hits = new Map<string, number[]>();
const mutationLimit = (req: Request, res: Response, next: NextFunction) => {
  const key = (req as any).user?.username || req.ip || 'anon';
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < 60_000);
  if (recent.length >= 30) return res.status(429).json({ error: 'Too many worker changes, slow down', code: 'RATE_LIMITED' });
  recent.push(now); hits.set(key, recent);
  next();
};

const actor = (req: Request) => (req as any).user?.username || 'unknown';
const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (e: any) {
    if (e instanceof WorkerError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[Workers]', e.message);
    res.status(500).json({ error: 'Internal error', code: 'INTERNAL' });
  }
};
const idOf = (req: Request) => String(req.params.id);

router.use(requireAdminSession);

router.get('/', wrap(async (_req, res) => { res.json(await WorkerNodeService.list()); })); // GET /api/admin/workers — cluster summary + workers
router.post('/', mutationLimit, wrap(async (req, res) => { res.status(201).json(await WorkerNodeService.add(req.body, actor(req))); })); // POST /api/admin/workers — register a Citus worker
router.get('/events', wrap(async (req, res) => { res.json(await WorkerNodeService.events(Number(req.query.limit) || 50)); })); // GET /api/admin/workers/events — audit trail
router.post('/sync', mutationLimit, wrap(async (req, res) => { res.json(await WorkerNodeService.sync(actor(req))); })); // POST /api/admin/workers/sync — reconcile with Citus metadata
router.post('/rebalance', mutationLimit, wrap(async (req, res) => { res.status(202).json(await WorkerNodeService.startRebalance(req.body || {}, actor(req))); })); // POST /api/admin/workers/rebalance — start shard rebalance
router.get('/rebalance/status', wrap(async (_req, res) => { res.json(await WorkerNodeService.rebalanceStatus()); })); // GET /api/admin/workers/rebalance/status — rebalance jobs
router.get('/tables', wrap(async (_req, res) => { res.json(await WorkerNodeService.tables()); })); // GET /api/admin/workers/tables — distributed tables
router.post('/tables/distribute', mutationLimit, wrap(async (req, res) => { res.status(201).json(await WorkerNodeService.distribute(req.body, actor(req))); })); // POST /api/admin/workers/tables/distribute — distribute a tenant table
router.post('/health', mutationLimit, wrap(async (_req, res) => { res.json(await WorkerNodeService.health()); })); // POST /api/admin/workers/health — probe all workers

router.get('/:id', wrap(async (req, res) => { res.json(await WorkerNodeService.get(idOf(req))); })); // GET /api/admin/workers/:id — one worker
router.patch('/:id', mutationLimit, wrap(async (req, res) => { res.json(await WorkerNodeService.update(idOf(req), req.body || {}, actor(req))); })); // PATCH /api/admin/workers/:id — rename/labels/shouldHaveShards
router.post('/:id/activate', mutationLimit, wrap(async (req, res) => { res.json(await WorkerNodeService.activate(idOf(req), actor(req))); })); // POST /api/admin/workers/:id/activate — accept shards again
router.post('/:id/drain', mutationLimit, wrap(async (req, res) => { res.status(202).json(await WorkerNodeService.drain(idOf(req), actor(req))); })); // POST /api/admin/workers/:id/drain — move shards off the node
router.post('/:id/health', mutationLimit, wrap(async (req, res) => { res.json(await WorkerNodeService.health(idOf(req))); })); // POST /api/admin/workers/:id/health — probe one worker
router.delete('/:id', mutationLimit, wrap(async (req, res) => { await WorkerNodeService.remove(idOf(req), actor(req)); res.status(204).end(); })); // DELETE /api/admin/workers/:id — remove (must hold no shards)

export default router;
