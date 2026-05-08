import { Router } from 'express';
import * as queryController from '../controllers/queryController';

const router = Router();

router.post('/engine', queryController.executeEngineQuery);
router.post('/exec', queryController.executeRawSql); // This handles both Sync/Async based on 'async' flag
router.post('/native', queryController.executeNativeSql); // Direct Postgres hub SQL
router.get('/jobs/:id', queryController.getJobStatus);
router.get('/status/:id', queryController.getJobStatus);

export default router;
