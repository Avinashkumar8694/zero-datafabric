/**
 * @module routes/triggerRoutes
 * @description Trigger control-plane router, mounted at `/api/triggers` behind
 * `requireAuth`. Covers trigger CRUD, deployment, execution log inspection,
 * and the async trigger-job queue (list/retry). Note: `/logs/list` and
 * `/jobs/list` are registered before the `:id` param routes so they aren't
 * shadowed by them.
 */

import { Router } from 'express';
import * as triggersController from '../controllers/triggersController';

const router = Router();

router.get('/', triggersController.listTriggers); // GET /api/triggers — list triggers for the caller's tenant
router.post('/', triggersController.createTrigger); // POST /api/triggers — create a trigger
router.put('/:id', triggersController.updateTrigger); // PUT /api/triggers/:id — update a trigger
router.delete('/:id', triggersController.deleteTrigger); // DELETE /api/triggers/:id — delete a trigger
router.post('/:id/deploy', triggersController.deployTrigger); // POST /api/triggers/:id/deploy — deploy (activate) a trigger
router.get('/logs/list', triggersController.listTriggerLogs); // GET /api/triggers/logs/list?triggerId=&limit=&offset= — trigger execution logs
router.get('/jobs/list', triggersController.listTriggerJobs); // GET /api/triggers/jobs/list — list the async trigger-job queue
router.post('/jobs/:id/retry', triggersController.retryTriggerJob); // POST /api/triggers/jobs/:id/retry — retry a failed trigger job

export default router;
