import { Router } from 'express';
import * as adminController from '../controllers/adminController';

const router = Router();

router.post('/create-tenant', adminController.createTenant);
router.post('/create-connection', adminController.createConnection);

export default router;
