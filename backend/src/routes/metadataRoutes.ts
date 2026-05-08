import { Router } from 'express';
import * as metadataController from '../controllers/metadataController';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/sources', metadataController.getSources);
router.get('/schemas', metadataController.getSchemas);
router.get('/tables', metadataController.getTables);
router.get('/tables/:name', metadataController.getTableDetails);
router.get('/template', metadataController.getTemplate);

router.post('/crawl', metadataController.crawlTenant);
router.post('/diff', upload.single('file'), metadataController.diffMetadata);
router.post('/apply', upload.single('file'), metadataController.applyMetadata);
router.post('/migrate', metadataController.migrateMetadata);

export default router;
