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

        // Seed hierarchical data
        const seedRes = await request(app).post('/api/queries/exec').set('Authorization', `Bearer ${scopedToken}`).send({
            sql: `INSERT INTO "tenant_${testTenantId}"."org" (name, parent_id) VALUES ('CEO', NULL), ('CTO', 1), ('Architect', 2), ('Developer', 3);`
        });
        if (seedRes.status !== 200) console.error('SEED FAILED:', seedRes.body);
        expect(seedRes.status).toBe(200);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Execute recursive CTE to retrieve org hierarchy', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: {
                type: 'SELECT',
                table: 'org_tree',
                withRecursive: {
                    name: 'org_tree',
                    baseQuery: `SELECT id, name, parent_id, 1 as level FROM "tenant_${testTenantId}"."org" WHERE parent_id IS NULL`,
                    recursiveQuery: `SELECT o.id, o.name, o.parent_id, ot.level + 1 FROM "tenant_${testTenantId}"."org" o JOIN org_tree ot ON o.parent_id = ot.id`
                },
                select: ['*'],
                orderBy: [{ field: 'level', dir: 'ASC' }],
                limit: 10
            }
        });

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(4);
        expect(res.body.data[0].name).toBe('CEO');
        expect(res.body.data[3].name).toBe('Developer');
        expect(res.body.data[3].level).toBe(4);
    });
});
