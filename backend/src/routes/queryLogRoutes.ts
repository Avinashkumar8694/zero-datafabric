/**
 * @module routes/queryLogRoutes
 * @description Query execution audit-trail router, mounted at `/api/query-logs`
 * behind `requireAuth`. Read-only access to the log of query executions
 * captured across `dataController`/`queryController`/`savedAnalyticsController`.
 */

import { Router } from 'express';
import { listQueryLogs, getQueryLog } from '../controllers/queryLogController';

const router = Router();
router.get('/', listQueryLogs); // GET /api/query-logs?limit=&status=&mode= — list recent query log entries
router.get('/:id', getQueryLog); // GET /api/query-logs/:id — fetch a single query log entry in full
export default router;
