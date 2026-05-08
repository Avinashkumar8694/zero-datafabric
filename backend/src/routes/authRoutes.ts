import { Router } from 'express';
import * as authController from '../controllers/authController';

const router = Router();

router.post('/login', authController.login);
router.post('/token', authController.refreshToken); // Token exchange / tenant scoping

export default router;
