import { Router } from 'express';
import { QueryEngineController } from '../modules/query-engine/query-engine.controller';

const router = Router();

router.post('/query', QueryEngineController.executeQuery);

router.post('/query-async', QueryEngineController.executeAsyncQuery);

router.get('/jobs/:jobId', QueryEngineController.getJobStatus);

router.post('/refresh-view', QueryEngineController.refreshView);

export default router;
