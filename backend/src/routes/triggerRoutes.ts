import { Router } from 'express';
import * as triggersController from '../controllers/triggersController';

const router = Router();

router.get('/', triggersController.listTriggers);
router.post('/', triggersController.createTrigger);
router.put('/:id', triggersController.updateTrigger);
router.delete('/:id', triggersController.deleteTrigger);
router.post('/:id/deploy', triggersController.deployTrigger);
router.get('/logs/list', triggersController.listTriggerLogs);
router.get('/jobs/list', triggersController.listTriggerJobs);
router.post('/jobs/:id/retry', triggersController.retryTriggerJob);

// Notification Channels
router.get('/channels/list', triggersController.listChannels);
router.post('/channels/save', triggersController.saveChannel);
router.delete('/channels/:id', triggersController.deleteChannel);

export default router;
