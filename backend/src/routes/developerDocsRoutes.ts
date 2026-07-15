import { Router } from 'express';
import * as developerDocsController from '../controllers/developerDocsController';

const router = Router();

router.get('/', developerDocsController.getDeveloperDocsList);
router.get('/:id', developerDocsController.getDeveloperDoc);

export default router;
