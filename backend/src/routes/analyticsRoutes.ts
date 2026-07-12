/**
 * @module routes/analyticsRoutes
 * @description Analytics/query-engine router, mounted at `/api/analytics` behind
 * `requireAuth`. Thin wrapper around `QueryEngineController` for running AST
 * queries (sync/async) against the fabric, polling async job status, and
 * refreshing materialized views.
 */

import { Router } from 'express';
import { QueryEngineController } from '../modules/query-engine/query-engine.controller';

const router = Router();

router.post('/query', QueryEngineController.executeQuery); // POST /api/analytics/query — execute a query synchronously

router.post('/query-async', QueryEngineController.executeAsyncQuery); // POST /api/analytics/query-async — enqueue a query for async execution

router.get('/jobs/:jobId', QueryEngineController.getJobStatus); // GET /api/analytics/jobs/:jobId — poll an async job's status
router.get('/query/status/:jobId', QueryEngineController.getJobStatus); // GET /api/analytics/query/status/:jobId — alias for job status polling

router.post('/refresh-view', QueryEngineController.refreshView); // POST /api/analytics/refresh-view — refresh a materialized view

export default router;
