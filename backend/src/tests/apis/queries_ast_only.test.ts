import request from 'supertest';
import { app } from '../../index';
import { getAdminToken, cleanupTenant, uniqueTenantId } from './test_helper';

/**
 * AST-only execution: raw SQL entry points are gone and any SQL text smuggled into a
 * request body is rejected with 400 SQL_NOT_SUPPORTED, while structured AST queries
 * keep working and stay tenant-isolated.
 */
const rowsOf = (body: any): any[] =>
    Array.isArray(body) ? body : (body?.results?.results ?? body?.data ?? body?.rows ?? []);

describe('AST-only execution (no raw SQL)', () => {
    let adminToken: string;
    const tenantA = uniqueTenantId('astoa');
    const tenantB = uniqueTenantId('astob');
    let tokenA: string;
    let tokenB: string;

    const post = (path: string, token: string, body: any) =>
        request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);

    beforeAll(async () => {
        adminToken = await getAdminToken();

        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantA, name: 'Tenant A' });
        const resA = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantA });
        tokenA = resA.body.token;

        await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id: tenantB, name: 'Tenant B' });
        const resB = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: tenantB });
        tokenB = resB.body.token;

        // Schema via manifest, rows via the CRUD API (no raw SQL anywhere).
        await post('/api/metadata/apply', tokenA, {
            version: '1.0',
            schemas: [{
                name: 'core',
                resources: [{
                    type: 'TABLE',
                    name: 'data_a',
                    columns: [
                        { name: 'id', type: 'SERIAL', primaryKey: true },
                        { name: 'val', type: 'TEXT' },
                    ],
                }],
            }],
        });
        await post('/api/data/create', tokenA, { schema: 'core', resource: 'data_a', data: { val: 'A_SECRET' } });
    });

    afterAll(async () => {
        await cleanupTenant(tenantA);
        await cleanupTenant(tenantB);
    });

    describe('removed endpoints', () => {
        it.each(['/api/queries/exec', '/api/queries/native'])('POST %s returns 404', async (path) => {
            const res = await post(path, tokenA, { type: 'SELECT', table: 'data_a' });
            expect(res.status).toBe(404);
        });

        // astOnly runs before routing, so SQL bodies are refused by the guard (400) before the 404.
        it.each(['/api/queries/exec', '/api/queries/native'])('POST %s with a SQL body is rejected 400 SQL_NOT_SUPPORTED', async (path) => {
            const res = await post(path, tokenA, { sql: 'SELECT 1' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
        });
    });

    describe('SQL_NOT_SUPPORTED guard', () => {
        const endpoints = [
            '/api/queries/engine',
            '/api/queries/transpile',
            '/api/analytics/query',
            '/api/analytics/query-async',
            '/api/data/fetch',
            '/api/data/create',
            '/api/data/update',
            '/api/data/delete',
            '/api/saved-analytics',
        ];
        const payloads: Array<[string, any]> = [
            ['sql', { sql: 'SELECT * FROM data_a' }],
            ['rawSql', { rawSql: 'SELECT * FROM data_a' }],
            ['nativeSql', { nativeSql: 'SELECT * FROM data_a' }],
            ['rawQuery', { rawQuery: 'SELECT * FROM data_a' }],
            ['string query', { query: 'SELECT * FROM data_a' }],
            ['config.query.sql', { config: { query: { sql: 'SELECT * FROM data_a' } } }],
        ];

        for (const path of endpoints) {
            it.each(payloads)(`${path} rejects %s with 400 SQL_NOT_SUPPORTED`, async (_label, body) => {
                const res = await post(path, tokenA, body);
                expect(res.status).toBe(400);
                expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
            });
        }

        it('rejects case variants (RawSql)', async () => {
            const res = await post('/api/queries/engine', tokenA, { RawSql: 'SELECT 1' });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
        });

        it('saved analytics: SQL-mode definitions are refused', async () => {
            const res = await post('/api/saved-analytics', tokenA, { name: 'sql_one', mode: 'SQL', sql: 'SELECT 1' });
            expect([400, 410]).toContain(res.status);
            expect(res.body.code).toBe('SQL_NOT_SUPPORTED');
        });

        it('does not reject a row that has a column named "sql" (data payload is not scanned)', async () => {
            const res = await post('/api/data/create', tokenA, { resource: 'data_a', data: { val: 'x', sql: 'SELECT 1' } });
            // The guard must not fire; the engine may still reject the unknown column.
            expect(res.body?.code).not.toBe('SQL_NOT_SUPPORTED');
        });
    });

    describe('AST queries still work', () => {
        it('Tenant A can SELECT its own data via the AST engine', async () => {
            const res = await post('/api/queries/engine', tokenA, { type: 'SELECT', schema: 'core', table: 'data_a', limit: 10 });
            expect(res.status).toBe(200);
            expect(rowsOf(res.body).map((r: any) => r.val)).toContain('A_SECRET');
        });

        it('Tenant A can run the same AST via /api/analytics/query', async () => {
            const res = await post('/api/analytics/query', tokenA, {
                queryConfig: { type: 'SELECT', schema: 'core', table: 'data_a', filter: { val: 'A_SECRET' }, limit: 10 },
            });
            expect(res.status).toBe(200);
            expect(rowsOf(res.body).length).toBeGreaterThan(0);
        });

        it('Tenant B cannot read Tenant A rows through the AST engine', async () => {
            const res = await post('/api/queries/engine', tokenB, { type: 'SELECT', schema: 'core', table: 'data_a', limit: 10 });
            expect(JSON.stringify(res.body)).not.toContain('A_SECRET');
            if (res.status === 200) expect(rowsOf(res.body).length).toBe(0);
            else expect(res.status).toBeGreaterThanOrEqual(400);
        });

        it('Tenant B cannot read Tenant A rows via a schema-qualified table reference', async () => {
            const res = await post('/api/queries/engine', tokenB, { type: 'SELECT', table: `tenant_${tenantA}_core.data_a`, limit: 10 });
            expect(JSON.stringify(res.body)).not.toContain('A_SECRET');
            if (res.status === 200) expect(rowsOf(res.body).length).toBe(0);
        });
    });

    describe('/api/queries/transpile (preview only)', () => {
        it('returns the SQL for an AST without executing it', async () => {
            const res = await post('/api/queries/transpile', tokenA, {
                config: { type: 'SELECT', schema: 'core', limit: 5, query: { from: { resource: 'data_a' }, select: ['id', 'val'] } },
            });
            expect(res.status).toBe(200);
            expect(typeof res.body.sql).toBe('string');
            expect(res.body.sql.toLowerCase()).toContain('select');
            expect(res.body.sql.toLowerCase()).toContain('data_a');
        });
    });
});
