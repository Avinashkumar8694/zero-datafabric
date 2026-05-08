import request from 'supertest';
import { app } from '../index';
import { pool } from '../config/database';

describe('🏛️ Industrial Data Fabric: The Ultimate Orchestration Test Suite', () => {
    let adminToken: string;
    let tenantToken: string;
    const testTenantId = 'ultimate_test_tenant_v5';

    beforeAll(async () => {
        await pool.query('SELECT 1');
    });

    afterAll(async () => {
        await pool.query('DELETE FROM public.users WHERE tenant_id = $1 OR username = $2', [testTenantId, 'temp_user']);
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [testTenantId]);
        await pool.query(`DROP SCHEMA IF EXISTS tenant_${testTenantId} CASCADE`);
        await pool.end();
    });

    describe('🔐 [Auth Scenarios]', () => {
        it('should login admin successfully', async () => {
            const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
            expect(res.status).toBe(200);
            adminToken = res.body.token;
        });

        it('should fail login with empty payload', async () => {
            await request(app).post('/api/auth/login').send({}).expect(401);
        });

        it('should generate scoped token for Tenant A', async () => {
            const res = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: 'tenant_A' });
            expect(res.status).toBe(200);
            tenantToken = res.body.token;
        });
    });

    describe('🏢 [Tenant Scenarios]', () => {
        it('should provision new tenant', async () => {
            await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Ultimate V5' }).expect(201);
        });

        it('should list active tenants', async () => {
            const res = await request(app).get('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`);
            expect(res.body.some((t: any) => t.id === testTenantId)).toBe(true);
        });

        it('should delete a temporary tenant', async () => {
            const tempId = 'temp_tenant_delete';
            await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tempId, name: 'Temp' });
            await request(app).delete(`/api/admin/tenants/${tempId}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
        });
    });

    describe('📚 [Metadata Scenarios]', () => {
        it('should detect schema drift', async () => {
            const res = await request(app).post('/api/metadata/diff').set('Authorization', `Bearer ${adminToken}`).send({
                schemas: [{ name: 'enterprise_core', tables: [{ name: 'drift_check_v5', columns: [{ name: 'id', type: 'SERIAL' }] }] }]
            });
            expect(res.status).toBe(200);
        });

        it('should orchestrate full schema lifecycle', async () => {
            const plan = [{ action: 'CREATE_TABLE', table: 'data_store_v5', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'val', type: 'INTEGER' }] } }];
            await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${adminToken}`).send({ migrationPlan: plan }).expect(200);
        });
    });

    describe('📈 [Analytics Scenarios]', () => {
        it('should execute AST query with filters', async () => {
            await request(app).post('/api/queries/exec').set('Authorization', `Bearer ${adminToken}`).send({ 
                sql: 'INSERT INTO "tenant_tenant_A"."data_store_v5" (val) VALUES (777)' 
            });
            
            const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${adminToken}`).send({
                queryConfig: { type: 'SELECT', table: 'data_store_v5', filter: { val: { $eq: 777 } }, limit: 1 }
            });
            expect(res.status).toBe(200);
            expect(res.body.data[0].val).toBe(777);
        });

        it('should handle async query jobs', async () => {
            const start = await request(app).post('/api/analytics/query-async').set('Authorization', `Bearer ${adminToken}`).send({ queryConfig: { type: 'SELECT', table: 'data_store_v5', limit: 1 } });
            const jobId = start.body.jobId;
            const status = await request(app).get(`/api/analytics/jobs/${jobId}`).set('Authorization', `Bearer ${adminToken}`);
            expect(status.status).toBe(200);
        });
    });

    describe('🔗 [Integration Scenarios]', () => {
        it('should register and remove connections', async () => {
            // Use real remote DB details from docker-compose
            const reg = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${adminToken}`).send({
                name: 'conn_v5', 
                config: { 
                    type: 'postgres', 
                    host: 'localhost', 
                    port: 5436, 
                    dbName: 'remote_warehouse', 
                    user: 'remote_admin', 
                    pass: 'remote_password', 
                    syncType: 'VIRTUAL' 
                }
            });
            expect([200, 201]).toContain(reg.status);
            const sourceId = reg.body.sourceId;
            await request(app).delete(`/api/admin/connections/${sourceId}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
        });
    });

    describe('📊 [Observability Scenarios]', () => {
        it('should retrieve audit logs', async () => {
            await request(app).get('/api/admin/audit-logs').set('Authorization', `Bearer ${adminToken}`).expect(200);
        });

        it('should list system users', async () => {
            await request(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`).expect(200);
        });

        it('should check health', async () => {
            await request(app).get('/api/health').expect(200);
        });
    });
});
