/**
 * @module routes/queryRoutes
 * @description Query execution router, mounted at `/api/queries` behind
 * `requireAuth`. Covers AST-based query execution, raw/native SQL execution
 * (sync and async), SQL preview transpilation for the AST builder, and async
 * job status polling.
 */

import { Router } from 'express';
import * as queryController from '../controllers/queryController';

const router = Router();

router.post('/engine', queryController.executeEngineQuery); // POST /api/queries/engine — execute a fabric QueryConfig (AST)
router.post('/exec', queryController.executeRawSql); // POST /api/queries/exec — execute raw SQL; handles both sync/async based on 'async' flag
router.post('/native', queryController.executeNativeSql); // POST /api/queries/native — direct Postgres hub (or named source) SQL, no log capture
router.post('/transpile', queryController.transpileQuery); // POST /api/queries/transpile — AST → SQL preview (builder)
router.get('/jobs/:id', queryController.getJobStatus); // GET /api/queries/jobs/:id — poll an async query job's status
router.get('/status/:id', queryController.getJobStatus); // GET /api/queries/status/:id — alias for job status polling

export default router;
