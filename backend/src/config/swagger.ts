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
    },
  },
  // Look for swagger docs in routes and controllers
  apis: ['./src/routes/*.ts', './src/modules/**/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
