import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import jwt from 'jsonwebtoken';

describe('Module 2: Query Engine', () => {
  const secret = process.env.JWT_SECRET || 'reallyreallyreallyreallyverysecret';
  const tenantId = 'query_test_tenant';
  const token = jwt.sign({ 
    tenant_id: tenantId, 
    username: 'tester', 
    internal_role: 'USER',
    iat: Math.floor(Date.now() / 1000),
    iss: 'zero-data-fabric'
  }, secret);

  beforeAll(async () => {
    // Setup tenant for testing
    const provisioningToken = jwt.sign({ tenant_id: 'tenant_A', username: 'admin', internal_role: 'ADMIN' }, secret);
    await request(app)
      .post('/api/admin/tenants')
      .set('Authorization', `Bearer ${provisioningToken}`) // Admin token for provisioning
      .send({ id: tenantId, name: 'Query Test' });
  });

  afterAll(async () => {
    // Cleanup
    await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
    await pool.query(`DROP SCHEMA IF EXISTS tenant_${tenantId} CASCADE`);
    // pool.end() is handled by the last test file usually, or we can use a global teardown
  });

  it('should create a schema explicitly (Administrative)', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'CREATE_SCHEMA'
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'SUCCESS');
    expect(res.body.target).toBe(`tenant_${tenantId}`);
  });

  it('should create a table and auto-provision schema (Non-SQL AST flow)', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'CREATE_TABLE',
          table: 'test_table',
          schemaDef: {
            columns: [
              { name: 'id', type: 'SERIAL PRIMARY KEY' },
              { name: 'data', type: 'TEXT' }
            ]
          }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'SUCCESS');
  });

  it('should insert data via DML', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'INSERT',
          table: 'test_table',
          data: { data: 'hello jest' }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('returning');
    expect(res.body.returning[0]).toHaveProperty('data', 'hello jest');
  });

  it('should select data via DQL', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'SELECT',
          table: 'test_table',
          select: ['data'],
          limit: 10
        }
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toHaveProperty('data', 'hello jest');
  });

  it('should update data via DML', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'UPDATE',
          table: 'test_table',
          data: { data: 'updated jest' },
          filter: { data: 'hello jest' }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body.returning[0]).toHaveProperty('data', 'updated jest');
  });

  it('should alter table via DDL', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'ALTER_TABLE',
          table: 'test_table',
          alterDef: {
            action: 'ADD_COLUMN',
            columnName: 'new_col',
            columnType: 'INTEGER'
          }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'SUCCESS');
  });

  it('should execute async query', async () => {
    const res = await request(app)
      .post('/api/analytics/query-async')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'SELECT',
          table: 'test_table',
          limit: 10
        }
      });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');

    const jobId = res.body.jobId;
    
    // Poll for status
    let status = 'PENDING';
    for (let i = 0; i < 10; i++) { // Increased polling
      const statusRes = await request(app)
        .get(`/api/analytics/jobs/${jobId}`)
        .set('Authorization', `Bearer ${token}`);
      status = statusRes.body.status;
      if (status === 'COMPLETED') break;
      await new Promise(r => setTimeout(r, 500)); // Increased interval
    }
    expect(status).toBe('COMPLETED');
  });

  it('should create an index via DDL', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'CREATE_INDEX',
          table: 'test_table',
          indexDef: {
            name: 'idx_test_data',
            columns: ['data']
          }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'SUCCESS');
  });

  it('should distribute a table (Citus Specific)', async () => {
    // Note: We call the service directly or add a route if available
    // Currently there's no route for distributeTable in analyticsRoutes, 
    // but we can test the service logic.
    const { QueryEngineService } = require('./query-engine.service');
    const result = await QueryEngineService.distributeTable(`tenant_${tenantId}.test_table`, 'id');
    
    // If it's the first time, it should be DISTRIBUTED. 
    // If already done (e.g. by previous runs if not cleaned), it might be ALREADY_DISTRIBUTED.
    expect(['DISTRIBUTED', 'ALREADY_DISTRIBUTED']).toContain(result.status);
  });

  it('should delete data via DML', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'DELETE',
          table: 'test_table',
          filter: { data: 'updated jest' }
        }
      });

    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(1);
  });


  it('should drop table via DDL', async () => {
    const res = await request(app)
      .post('/api/analytics/query')
      .set('Authorization', `Bearer ${token}`)
      .send({
        queryConfig: {
          type: 'DROP_TABLE',
          table: 'test_table'
        }
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'SUCCESS');
  });
});
