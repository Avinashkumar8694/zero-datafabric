import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant } from './test_helper';

describe('Analytics: Recursive CTE Orchestration', () => {
    let adminToken: string;
    const ts = Date.now();
    const testTenantId = `recursive_cte_${ts}`;

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Recursive CTE' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        // Setup Org Chart schema
        const migRes = await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${scopedToken}`).send({
            migrationPlan: [
                { action: 'CREATE_SCHEMA' },
                { action: 'CREATE_TABLE', table: 'org', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'name', type: 'TEXT' }, { name: 'parent_id', type: 'INTEGER' }] } }
            ]
        });
        expect(migRes.status).toBe(200);

        // Seed hierarchical data through the CRUD API (no raw SQL)
        const seedRes = await request(app).post('/api/data/create').set('Authorization', `Bearer ${scopedToken}`).send({
            resource: 'org',
            data: [
                { name: 'CEO', parent_id: null },
                { name: 'CTO', parent_id: 1 },
                { name: 'Architect', parent_id: 2 },
                { name: 'Developer', parent_id: 3 }
            ]
        });
        if (seedRes.status !== 200) console.error('SEED FAILED:', seedRes.body);
        expect(seedRes.status).toBe(200);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Walk the org hierarchy with an AST recursive traversal', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: {
                type: 'SELECT',
                query: {
                    from: { resource: 'org' },
                    select: ['id', 'name', 'parent_id'],
                    recursive: {
                        resource: 'org',
                        select: ['id', 'name', 'parent_id'],
                        connectBy: { parent: 'parent_id', child: 'id' },
                        direction: 'down',
                        maxDepth: 10
                    }
                }
            }
        });

        expect(res.status).toBe(200);
        const names = res.body.data.map((r: any) => r.name);
        expect(names).toHaveLength(4);
        expect(names).toEqual(expect.arrayContaining(['CEO', 'CTO', 'Architect', 'Developer']));
    });

    it('Rejected: hand-written SQL fragments are not an accepted recursive form', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${tokenRes.body.token}`).send({
            sql: 'WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t',
            queryConfig: { type: 'SELECT', table: 'org' }
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
    });
});
