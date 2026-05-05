import { Router } from 'express';
import { QueryEngineController } from '../modules/query-engine/query-engine.controller';

const router = Router();

// Analytics module routes
router.post('/refresh-view', QueryEngineController.refreshView);
router.post('/query', QueryEngineController.executeQuery);
router.post('/query-async', QueryEngineController.executeAsyncQuery);
router.get('/jobs/:jobId', QueryEngineController.getJobStatus);

export default router;
