/**
 * @module routes/queryRoutes
 * @description Query execution router, mounted at `/api/queries` behind
 * `requireAuth`. Covers AST-based query execution (SQL execution was removed: AST only),
 * SQL preview transpilation for the AST builder, and async
 * job status polling.
 */

import { Router } from 'express';
import * as queryController from '../controllers/queryController';

const router = Router();

router.post('/engine', queryController.executeEngineQuery); // POST /api/queries/engine — execute a fabric QueryConfig (AST)
router.post('/transpile', queryController.transpileQuery); // POST /api/queries/transpile — AST → SQL preview (builder)
router.get('/jobs/:id', queryController.getJobStatus); // GET /api/queries/jobs/:id — poll an async query job's status
router.get('/status/:id', queryController.getJobStatus); // GET /api/queries/status/:id — alias for job status polling

export default router;
