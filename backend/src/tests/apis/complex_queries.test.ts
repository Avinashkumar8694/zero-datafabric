import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId } from './test_helper';

describe('Data Fabric: Industrial Complex Queries', () => {
    let token: string;
    const tenantId = uniqueTenantId('cplx');

    beforeAll(async () => {
        token = await createTenantViaApi(await getAdminToken(), tenantId, 'Complex Test Tenant');

        // Schema via manifest, rows via the CRUD API (no raw SQL, no owner-pool seeding)
        const applied = await request(app).post('/api/metadata/apply').set('Authorization', `Bearer ${token}`).send({
            version: '1.0',
            schemas: [{
                name: 'core',
                resources: [
                    { type: 'TABLE', name: 'users', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }, { name: 'name', type: 'TEXT' }, { name: 'email', type: 'TEXT' }] },
                    { type: 'TABLE', name: 'orders', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'user_id', type: 'INTEGER' }, { name: 'amount', type: 'NUMERIC' }, { name: 'status', type: 'TEXT' }] },
                ],
            }],
        });
        if (applied.status !== 200) console.error('Manifest apply failed:', JSON.stringify(applied.body));
        expect(applied.status).toBe(200);

        const create = (resource: string, data: any[]) =>
            request(app).post('/api/data/create').set('Authorization', `Bearer ${token}`).send({ schema: 'core', resource, data });
        expect((await create('users', [{ id: 1, name: 'Alice', email: 'alice@example.com' }, { id: 2, name: 'Bob', email: 'bob@example.com' }])).status).toBe(200);
        expect((await create('orders', [
            { user_id: 1, amount: 100.5, status: 'COMPLETED' },
            { user_id: 1, amount: 50, status: 'PENDING' },
            { user_id: 2, amount: 200, status: 'COMPLETED' },
        ])).status).toBe(200);
    });

    afterAll(async () => {
        await cleanupTenant(tenantId);
    });

    it('Success: Execute Join Query with Aliases and Filters', async () => {
        const res = await request(app)
            .post('/api/analytics/query')
            .set('Authorization', `Bearer ${token}`)
            .send({
                queryConfig: {
                    type: 'SELECT',
                    schema: 'core',
                    limit: 10,
                    query: {
                        from: { resource: 'users', alias: 'u' },
                        select: ['u.name', 'o.amount', 'o.status'],
                        joins: [{ type: 'INNER', resource: 'orders', alias: 'o', on: { left: 'u.id', operator: 'EQ', right: 'o.user_id' } }],
                        where: [
                            { column: 'o.status', operator: 'EQ', value: 'COMPLETED' },
                            { column: 'u.name', operator: 'NE', value: 'Eve' },
                        ],
                        orderBy: [{ column: 'o.amount', direction: 'DESC' }],
                    },
                },
            });

        if (res.status !== 200) console.error('Complex Join Error:', res.body.error);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(2);
        expect(res.body.data.map((r: any) => Number(r['o.amount'] ?? r.amount))).toEqual([200, 100.5]);
    });

    it('Success: Advanced Filter with $in Operator', async () => {
        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({
                type: 'SELECT',
                schema: 'core',
                table: 'users',
                filter: {
                    'name': { '$in': ['Alice', 'Charlie'] }
                },
                limit: 10
            });

        if (res.status !== 200) console.error('Filter $in Error:', res.body.error);
        expect(res.status).toBe(200);
        expect(res.body.data.length).toBe(1);
    });
});
