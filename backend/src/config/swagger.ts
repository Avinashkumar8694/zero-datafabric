import swaggerJsdoc from 'swagger-jsdoc';

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
      },
    },
  },
  // Look for swagger docs in routes, controllers and main index
    apis: [
      './src/index.ts', 
      './src/modules/**/*.controller.ts', 
      './src/routes/*.ts',
      './src/docs/swagger-definitions.ts'
    ],
};

export const swaggerSpec = swaggerJsdoc(options);
