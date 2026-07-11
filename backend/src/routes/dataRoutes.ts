import { Router } from 'express';
import * as dataController from '../controllers/dataController';

const router = Router();

// Simple REST-style CRUD over federated sources.
router.post('/sequence', dataController.nextSequence);
router.post('/fetch', dataController.fetchData);
router.post('/create', dataController.createData);
router.post('/update', dataController.updateData);
router.post('/delete', dataController.deleteData);

export default router;
