/**
 * @module routes/dataRoutes
 * @description Simple REST-style CRUD router over federated sources, mounted
 * at `/api/data` behind `requireAuth`. Each route accepts an ergonomic JSON
 * body (`(source?, schema?, resource, where?, data?, ...)`) rather than raw
 * SQL/AST, and is captured to the query log by `dataController`'s shared
 * `handle` wrapper.
 */

import { Router } from 'express';
import * as dataController from '../controllers/dataController';

const router = Router();

// Simple REST-style CRUD over federated sources.
router.post('/sequence', dataController.nextSequence); // POST /api/data/sequence — allocate next sequence value(s)
router.post('/fetch', dataController.fetchData); // POST /api/data/fetch — fetch rows from a resource
router.post('/call', dataController.callFunction); // POST /api/data/call — invoke a provisioned function/procedure
router.post('/create', dataController.createData); // POST /api/data/create — insert row(s) into a resource
router.post('/update', dataController.updateData); // POST /api/data/update — update row(s) matching a filter
router.post('/delete', dataController.deleteData); // POST /api/data/delete — delete row(s) matching a filter

export default router;
