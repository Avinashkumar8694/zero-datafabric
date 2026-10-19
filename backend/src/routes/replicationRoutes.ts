/**
 * @module routes/replicationRoutes
 * @description Source→source replication router, mounted at `/api/replication`
 * behind `requireAuth`. Manages replication jobs and disaster-recovery restore.
 */
import { Router } from 'express';
import * as ctrl from '../controllers/replicationController';

const router = Router();

router.get('/', ctrl.listJobs);            // GET  /api/replication — list jobs
router.get('/analytics', ctrl.analytics);  // GET  /api/replication/analytics — copy-job analytics
router.get('/tracking', ctrl.tracking);    // GET  /api/replication/tracking?source= — smart tracking preview
router.get('/runs', ctrl.listRuns);        // GET  /api/replication/runs — list copy-job runs
router.get('/runs/:runId', ctrl.getRun);   // GET  /api/replication/runs/:runId — one run status/result
router.post('/runs/:runId/pause', ctrl.pauseRun);   // POST pause a running job
router.post('/runs/:runId/resume', ctrl.resumeRun); // POST resume a paused/failed job
router.post('/', ctrl.createJob);          // POST /api/replication — create a job
router.post('/:id/run', ctrl.runJob);      // POST /api/replication/:id/run — enqueue REPLICATE run
router.post('/:id/restore', ctrl.restoreJob); // POST /api/replication/:id/restore — enqueue DR RESTORE
router.delete('/:id', ctrl.deleteJob);     // DELETE /api/replication/:id

export default router;
