/**
 * @module routes/savedAnalyticsRoutes
 * @description Saved-analytics control-plane router, mounted at
 * `/api/saved-analytics` behind `requireAuth`. Manages reusable, parameterized
 * analytics (AST or SQL with `({variable})` bindings) and runs them on demand.
 * Note: `/top` and `/:id` are both GET routes — `/top` is registered first so
 * it is matched before the `:id` param route.
 */

import { Router } from 'express';
import { listAnalytics, topAnalytics, getAnalytic, createAnalytic, deleteAnalytic, runAnalytic } from '../controllers/savedAnalyticsController';

const router = Router();
router.get('/', listAnalytics); // GET /api/saved-analytics — list saved analytics for the caller's tenant
router.get('/top', topAnalytics); // GET /api/saved-analytics/top?limit= — top/most-used saved analytics
router.post('/', createAnalytic); // POST /api/saved-analytics — create a saved analytic
router.get('/:id', getAnalytic); // GET /api/saved-analytics/:id — fetch a saved analytic by id
router.delete('/:id', deleteAnalytic); // DELETE /api/saved-analytics/:id — delete a saved analytic
router.post('/:id/run', runAnalytic); // POST /api/saved-analytics/:id/run — run a saved analytic with variable bindings
export default router;
