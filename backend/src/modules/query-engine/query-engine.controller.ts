import { Request, Response } from 'express';
import { QueryEngineService, QueryConfig } from './query-engine.service';
import crypto from 'crypto';

/**
 * @swagger
 * tags:
 *   name: Analytics
 *   description: Advanced Query Engine & Analytics Management
 */
export class QueryEngineController {
  
  /**
   * @swagger
   * /api/analytics/refresh-view:
   *   post:
   *     summary: Trigger Materialized View Refresh
   *     description: Provides an API endpoint for orchestration tools to manually trigger a refresh of analytical views.
   *     tags: [Analytics]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tenantId
   *               - viewName
   *             properties:
   *               tenantId:
   *                 type: string
   *                 example: "tenant-123"
   *               viewName:
   *                 type: string
   *                 example: "sales_aggregation_mv"
   *               concurrent:
   *                 type: boolean
   *                 default: true
   *                 example: true
   *     responses:
   *       202:
   *         description: View refresh initiated in background
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: "accepted"
   *                 message:
   *                   type: string
   *                   example: "View refresh initiated in background"
   *                 jobId:
   *                   type: string
   *                   example: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
   */
  static async refreshView(req: Request, res: Response) {
    try {
      const { tenantId, viewName, concurrent = true } = req.body;

      if (!tenantId || !viewName) {
        return res.status(400).json({ error: 'tenantId and viewName are required' });
      }

      QueryEngineService.refreshMaterializedView(tenantId, viewName, concurrent).catch(err => {
        console.error(`Background refresh failed for ${viewName}:`, err);
      });

      const jobId = crypto.randomUUID();

      return res.status(202).json({
        status: "accepted",
        message: "View refresh initiated in background",
        jobId: jobId
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * @swagger
   * /api/analytics/query:
   *   post:
   *     summary: Execute dynamic queries, CRUD, and DDL
   *     description: Execute AST-based configurations for SELECT, INSERT, UPDATE, DELETE, CREATE_TABLE, and CREATE_INDEX.
   *     tags: [Analytics]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tenantId
   *               - queryConfig
   *             properties:
   *               tenantId:
   *                 type: string
   *                 example: "tenant-123"
   *               queryConfig:
   *                 type: object
   *                 description: AST Query definition
   *                 properties:
   *                   type: 
   *                     type: string
   *                     enum: [SELECT, INSERT, UPDATE, DELETE, CREATE_TABLE, CREATE_INDEX]
   *                     example: "CREATE_TABLE"
   *                   table:
   *                     type: string
   *                     example: "customers"
   *                   schemaDef:
   *                     type: object
   *                     description: Used for CREATE_TABLE
   *                     properties:
   *                       columns:
   *                         type: array
   *                         items:
   *                           type: object
   *                         example: [{"name": "id", "type": "UUID", "constraints": "PRIMARY KEY"}, {"name": "name", "type": "VARCHAR(255)"}]
   *                   data:
   *                     type: object
   *                     description: Payload for INSERT and UPDATE operations
   *                     example: {"id": "123e4567-e89b-12d3-a456-426614174000", "name": "Acme Corp"}
   *     responses:
   *       200:
   *         description: Query executed successfully (returns rows for DQL/DML, status for DDL)
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   */
  static async executeQuery(req: Request, res: Response) {
    try {
      const { tenantId, queryConfig } = req.body;
      
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const data = await QueryEngineService.executeQuery(tenantId, queryConfig as QueryConfig);
      
      return res.status(200).json({ data });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * @swagger
   * /api/analytics/query-async:
   *   post:
   *     summary: Execute query asynchronously
   *     description: Submit a massive analytical query to the background job queue. Returns a jobId immediately.
   *     tags: [Analytics]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - tenantId
   *               - queryConfig
   *             properties:
   *               tenantId:
   *                 type: string
   *                 example: "tenant-123"
   *               queryConfig:
   *                 type: object
   *                 description: AST Query definition
   *     responses:
   *       202:
   *         description: Query accepted for background execution
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 jobId:
   *                   type: string
   *                 status:
   *                   type: string
   *                   example: "PENDING"
   */
  static async executeAsyncQuery(req: Request, res: Response) {
    try {
      const { tenantId, queryConfig } = req.body;
      
      if (!tenantId || !queryConfig) {
        return res.status(400).json({ error: 'tenantId and queryConfig are required' });
      }

      const jobId = QueryEngineService.executeAsyncQuery(tenantId, queryConfig as QueryConfig);
      
      return res.status(202).json({ jobId, status: 'PENDING' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * @swagger
   * /api/analytics/jobs/{jobId}:
   *   get:
   *     summary: Get async query job status
   *     description: Poll the status of a background query. Returns results if completed.
   *     tags: [Analytics]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Job status and/or results
   */
  static async getJobStatus(req: Request, res: Response) {
    try {
      const jobId = req.params.jobId as string;
      const job = QueryEngineService.getJobStatus(jobId);
      
      if (job.status === 'NOT_FOUND') {
        return res.status(404).json(job);
      }
      
      return res.status(200).json(job);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }
}
