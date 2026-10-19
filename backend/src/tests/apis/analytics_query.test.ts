import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, uniqueTenantId } from './test_helper';

describe('Analytics: Complex Relational Scenarios (M:M, Aggregations)', () => {
    let adminToken: string;
    const testTenantId = uniqueTenantId('acx');

    beforeAll(async () => {
        adminToken = await getAdminToken();
        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: testTenantId, name: 'Analytics Complex' });
        
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        // Setup M:M schema
        const migrated = await request(app).post('/api/metadata/migrate').set('Authorization', `Bearer ${scopedToken}`).send({
            migrationPlan: [
                { action: 'CREATE_SCHEMA' },
                { action: 'CREATE_TABLE', table: 'users', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'name', type: 'TEXT' }] } },
                { action: 'CREATE_TABLE', table: 'roles', details: { columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'role_name', type: 'TEXT' }] } },
                { action: 'CREATE_TABLE', table: 'user_roles', details: { columns: [{ name: 'user_id', type: 'INTEGER' }, { name: 'role_id', type: 'INTEGER' }], compositePrimaryKey: ['user_id', 'role_id'] } }
            ]
        });

        expect(migrated.status).toBe(200);

        // Seed data via the CRUD API
        const seed = (resource: string, data: any[]) =>
            request(app).post('/api/data/create').set('Authorization', `Bearer ${scopedToken}`).send({ resource, data });
        await seed('users', [{ name: 'Alice' }, { name: 'Bob' }]);
        await seed('roles', [{ role_name: 'Admin' }, { role_name: 'Editor' }]);
        await seed('user_roles', [{ user_id: 1, role_id: 1 }, { user_id: 1, role_id: 2 }, { user_id: 2, role_id: 2 }]);
    });

    afterAll(async () => {
        await cleanupTenant(testTenantId);
    });

    it('Success: Execute M:M JOIN with multiple tables and filters', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: {
                type: 'SELECT',
                table: 'users',
                select: ['users.name', 'roles.role_name'],
                joins: [
                    { type: 'INNER', table: 'user_roles', on: 'users.id = user_roles.user_id' },
                    { type: 'INNER', table: 'roles', on: 'user_roles.role_id = roles.id' }
                ],
                filter: { 'roles.role_name': { '$eq': 'Admin' } }
            }
        });

        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].name).toBe('Alice');
        expect(res.body.data[0].role_name).toBe('Admin');
    });

    it('Success: Perform Analytical Aggregation (GROUP BY)', async () => {
        const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: testTenantId });
        const scopedToken = tokenRes.body.token;

        const res = await request(app).post('/api/analytics/query').set('Authorization', `Bearer ${scopedToken}`).send({
            queryConfig: {
                type: 'SELECT',
                table: 'users',
                select: ['roles.role_name', 'count(*) as user_count'],
                joins: [
                    { type: 'INNER', table: 'user_roles', on: 'users.id = user_roles.user_id' },
                    { type: 'INNER', table: 'roles', on: 'user_roles.role_id = roles.id' }
                ],
                groupBy: ['roles.role_name']
            }
        });

        expect(res.status).toBe(200);
        const adminRole = res.body.data.find((r: any) => r.role_name === 'Admin');
        const editorRole = res.body.data.find((r: any) => r.role_name === 'Editor');
        expect(adminRole.user_count).toBe("1");
        expect(editorRole.user_count).toBe("2");
    });
});
