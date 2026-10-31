import request from 'supertest';
import { app } from '../index';
import { pool } from '../config/database';
import { cleanupTenant, uniqueTenantId, describeIfRemotePg, remotePgConfig } from './apis/test_helper';

describe('🏛️ Industrial Data Fabric: The Ultimate Orchestration Test Suite', () => {
    let adminToken: string;
    let tenantToken: string;
    const testTenantId = uniqueTenantId('ult');
    let scopedToken: string;

    beforeAll(async () => {
        await pool.query('SELECT 1');
    });

    afterAll(async () => {
        await pool.query('DELETE FROM public.users WHERE username = $1', ['temp_user']);
        await cleanupTenant(testTenantId);
        await cleanupTenant(`${testTenantId}t`);
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
            const tok = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
            scopedToken = tok.body.token;
        });

        it('should list active tenants', async () => {
            const res = await request(app).get('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`);
            expect(res.body.some((t: any) => t.id === testTenantId)).toBe(true);
        });

        it('should delete a temporary tenant', async () => {
            const tempId = `${testTenantId}t`;
            await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tempId, name: 'Temp' }).expect(201);
            await request(app).delete(`/api/admin/tenants/${tempId}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
        });
    });

    describe('📚 [Metadata Scenarios]', () => {
        it('should detect schema drift', async () => {
            const res = await request(app).post('/api/metadata/diff').set('Authorization', `Bearer ${scopedToken}`).send({
                version: '1.0',
                schemas: [{ name: 'enterprise_core', resources: [{ type: 'TABLE', name: 'drift_check_v5', columns: [{ name: 'id', type: 'SERIAL' }] }] }]
            });
            expect(res.status).toBe(200);
        });

        it('should orchestrate full schema lifecycle', async () => {
            const plan = [{ action: 'CREATE_TABLE', table: 'data_store_v5', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'val', type: 'INTEGER' }] } }];
            await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${scopedToken}`).send({ migrationPlan: plan }).expect(200);
        });
    });

    describe('📈 [Analytics Scenarios]', () => {
        it('should execute AST query with filters', async () => {
            await request(app).post('/api/data/create').set('Authorization', `Bearer ${scopedToken}`).send({ resource: 'data_store_v5', data: { val: 777 } });
            
            const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
                queryConfig: { type: 'SELECT', table: 'data_store_v5', filter: { val: { $eq: 777 } }, limit: 1 }
            });
            expect(res.status).toBe(200);
            expect(res.body.data[0].val).toBe(777);
        });

        it('should handle async query jobs', async () => {
            const start = await request(app).post('/api/analytics/query-async').set('Authorization', `Bearer ${scopedToken}`).send({ queryConfig: { type: 'SELECT', table: 'data_store_v5', limit: 1 } });
            const jobId = start.body.jobId;
            const status = await request(app).get(`/api/analytics/jobs/${jobId}`).set('Authorization', `Bearer ${scopedToken}`);
            expect(status.status).toBe(200);
        });
    });

    describe('🔗 [Integration Scenarios]', () => {
        // Needs the remote warehouse Postgres (docker-compose :5436, or REMOTE_PG_HOST / REMOTE_PG_PORT); skipped when it is not reachable.
        (describeIfRemotePg())('remote warehouse', () => {
            it('should register and remove connections', async () => {
                const reg = await request(app).post('/api/admin/connections').set('Authorization', `Bearer ${scopedToken}`).send({
                    name: 'conn_v5',
                    config: remotePgConfig(),
                });
                expect([200, 201]).toContain(reg.status);
                const sourceId = reg.body.sourceId;
                await request(app).delete(`/api/admin/connections/${sourceId}`).set('Authorization', `Bearer ${scopedToken}`).expect(200);
            });
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
