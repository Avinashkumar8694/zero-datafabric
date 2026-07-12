/**
 * @module routes/metadataRoutes
 * @description Metadata/catalog control-plane router, mounted at `/api/metadata`
 * behind `requireAuth`. Covers catalog browsing (sources/schemas/tables/columns/
 * relationships/preview), crawling, and the manifest-driven provisioning
 * lifecycle (diff/apply/history/rollback/migrate). The `diff`/`apply` routes
 * accept a manifest either as a `multipart/form-data` file upload (field
 * `file`, parsed via multer memory storage) or as a raw JSON body.
 */

import { Router } from 'express';
import * as metadataController from '../controllers/metadataController';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get('/sources', metadataController.getSources); // GET /api/metadata/sources — list registered data sources
router.get('/schemas', metadataController.getSchemas); // GET /api/metadata/schemas?sourceId= — list schemas under a source
router.get('/tables', metadataController.getTables); // GET /api/metadata/tables?schemaId= — list tables under a schema
router.get('/resource/:id', metadataController.getResourceDetails); // GET /api/metadata/resource/:id — full details for one catalog resource
router.get('/columns', metadataController.getColumns); // GET /api/metadata/columns?tableId=|source=&resource= — column metadata for a resource
router.get('/relationships', metadataController.getRelationships); // GET /api/metadata/relationships?schema= — FK/manifest relationships for ER diagrams
router.get('/preview', metadataController.getPreviewData); // GET /api/metadata/preview?tableId=&limit= — sample rows from a resource
router.get('/tables/:name', metadataController.getTableDetails); // GET /api/metadata/tables/:name — legacy column/description lookup by table name
router.get('/template', metadataController.getTemplate); // GET /api/metadata/template — blank manifest template
router.get('/export', metadataController.exportMetadata); // GET /api/metadata/export?source= — export the live catalog as a manifest

router.post('/crawl', metadataController.crawlTenant); // POST /api/metadata/crawl — crawl a tenant's connected sources
router.post('/diff', upload.single('file'), metadataController.diffMetadata); // POST /api/metadata/diff — analyze drift between a manifest and live state
router.post('/apply', upload.single('file'), metadataController.applyMetadata); // POST /api/metadata/apply?force= — apply a manifest (provision)
router.post('/migrate', metadataController.migrateMetadata); // POST /api/metadata/migrate — apply an ad-hoc migration plan

router.get('/history', metadataController.getMetadataHistory); // GET /api/metadata/history — manifest apply history
router.post('/rollback/:id', metadataController.rollbackMetadata); // POST /api/metadata/rollback/:id — roll back to a prior manifest version
router.get('/downstream', metadataController.getDownstreamStatus); // GET /api/metadata/downstream — status of downstream sync targets (ES/Snowflake)
router.post('/downstream/toggle', metadataController.toggleDownstream); // POST /api/metadata/downstream/toggle — enable/disable a downstream target

export default router;
