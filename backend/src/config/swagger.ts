import swaggerJsdoc from 'swagger-jsdoc';

/**
 * OpenAPI/Swagger spec generation for the Industrial Data Fabric Orchestrator
 * API. Builds a static `swagger-jsdoc` configuration (base OpenAPI 3.0
 * document, shared component schemas, and the source globs to scan for
 * `@swagger`/`@openapi` JSDoc annotations), then exports the compiled
 * (@link swaggerSpec) for mounting behind a docs route (e.g. `swagger-ui-express`).
 */

/** swagger-jsdoc options: base OpenAPI document (info/servers/components/schemas) plus the `apis` globs to scan for annotations. */
const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Industrial Data Fabric Orchestrator',
      version: '1.0.0',
      description: 'Enterprise-grade orchestration API for multi-tenant data virtualization, zero-trust security enforcement, and automated metadata cataloging.',
      contact: {
        name: 'Data Fabric Engineering',
        email: 'engineering@fabric.internal'
      }
    },
    servers: [
      {
        url: 'http://localhost:4000',
        description: 'Industrial Orchestrator',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Tenant: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'tenant_A' },
            name: { type: 'string', example: 'Acme Corp' },
            status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'], example: 'ACTIVE' },
          },
        },
        DataSource: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'src_1' },
            name: { type: 'string', example: 'InventoryDB' },
            type: { type: 'string', example: 'postgres' },
          },
        },
        MetadataRecord: {
          type: 'object',
          properties: {
            schema_name: { type: 'string', example: 'tenant_A' },
            table_name: { type: 'string', example: 'orders' },
            column_name: { type: 'string', example: 'id' },
            data_type: { type: 'string', example: 'integer' },
          },
        },
        AuditLog: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tenant_id: { type: 'string' },
            user_name: { type: 'string' },
            action: { type: 'string', enum: ['INSERT', 'UPDATE', 'DELETE'] },
            table_name: { type: 'string' },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'HEALTHY' },
            uptime: { type: 'string', example: '12h 30m' },
            database: {
              type: 'object',
              properties: {
                latency: { type: 'string', example: '5ms' },
              },
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Unauthorized access' },
          },
        },

        // ---- Query engine ----
        LegTrace: {
          type: 'object',
          description: 'One entry per source touched by a query — proof of where each piece ran and what was pushed down.',
          properties: {
            source: { type: 'string', example: 'Retail_Core' },
            engine: { type: 'string', example: 'POSTGRES' },
            mode: { type: 'string', enum: ['local', 'connector'], example: 'connector' },
            operation: { type: 'string', example: 'bind-join', description: 'scan | aggregate | join-driving | bind-join | partial-aggregate | union-leg | raw-sql | create | update | delete' },
            target: { type: 'string', example: 'public.orders' },
            query: { type: 'string', example: 'SELECT * FROM "public"."orders" WHERE "customer_id" = $1 LIMIT 50000' },
            params: { type: 'array', items: {}, example: [42] },
            rowsReturned: { type: 'integer', example: 2 },
            ms: { type: 'integer', example: 14 },
          },
        },
        QueryPlan: {
          type: 'object',
          description: 'How the query was executed across sources.',
          properties: {
            strategy: { type: 'string', enum: ['SINGLE_LOCAL', 'SINGLE_CONNECTOR', 'CROSS_ENGINE', 'SINGLE_CONNECTOR_RAW', 'SINGLE_CONNECTOR_WRITE'], example: 'CROSS_ENGINE' },
            executionMs: { type: 'integer', example: 24 },
            rowsScannedAcrossSources: { type: 'integer', example: 4, description: 'Total rows pulled from all sources — small vs. table size proves pushdown worked.' },
            pushed: { type: 'array', items: { type: 'string' } },
            legs: { type: 'array', items: { $ref: '#/components/schemas/LegTrace' } },
          },
        },
        QueryEnvelope: {
          type: 'object',
          description: 'Standard read response.',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
            rowCount: { type: 'integer', example: 4 },
            warnings: { type: 'array', items: { type: 'string' } },
            plan: { $ref: '#/components/schemas/QueryPlan' },
          },
        },
        WriteEnvelope: {
          type: 'object',
          description: 'Standard write response (create/update/delete).',
          properties: {
            status: { type: 'string', example: 'SUCCESS' },
            rowCount: { type: 'integer', example: 1 },
            returning: { type: 'array', items: { type: 'object' }, description: 'Affected rows (SQL sources) — RETURNING *.' },
            plan: { $ref: '#/components/schemas/QueryPlan' },
          },
        },

        // ---- AST query ----
        AstQuery: {
          type: 'object',
          description: 'The engine-agnostic query AST (the `query` field of queryConfig).',
          properties: {
            from: { type: 'object', properties: { resource: { type: 'string' }, source: { type: 'string' }, alias: { type: 'string' } }, example: { resource: 'orders', source: 'Retail_Core', alias: 'o' } },
            select: { type: 'array', items: {}, description: 'Column names and/or aggregate specs { aggregate, column, alias }.', example: ['id', 'region', { aggregate: 'SUM', column: 'total_amount', alias: 'revenue' }] },
            where: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, operator: { type: 'string', enum: ['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'LIKE', 'ILIKE', 'IN'] }, value: {} } }, example: [{ column: 'status', operator: 'EQ', value: 'SHIPPED' }] },
            joins: { type: 'array', items: { type: 'object' }, example: [{ type: 'INNER', resource: 'web_events', source: 'Web_Analytics', alias: 'w', on: { left: 'o.customer_id', operator: 'EQ', right: 'w.customer_id' } }] },
            groupBy: { type: 'array', items: { type: 'string' }, example: ['region'] },
            orderBy: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, direction: { type: 'string', enum: ['ASC', 'DESC'] } } } },
            limit: { type: 'integer', example: 50 },
            offset: { type: 'integer', example: 0 },
            union: { type: 'array', items: { type: 'object' }, description: 'Set operation legs (also intersect / except).' },
          },
        },
        QueryConfig: {
          type: 'object',
          required: ['type', 'query'],
          properties: {
            type: { type: 'string', example: 'SELECT' },
            schema: { type: 'string', example: 'public' },
            limit: { type: 'integer', example: 100 },
            query: { $ref: '#/components/schemas/AstQuery' },
          },
        },
      },
    },
  },
  // Look for swagger docs in routes, controllers and main index
    apis: [
      './src/index.ts', 
      './src/modules/**/*.controller.ts', 
      './src/routes/*.ts',
      './src/docs/swagger-definitions.ts',
      './src/docs/api-reference.ts'
    ],
};

export const swaggerSpec = swaggerJsdoc(options);
