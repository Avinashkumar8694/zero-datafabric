import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfReachable, describeIfRemotePg, remotePgConfig, withRemotePg } from './test_helper';

jest.setTimeout(30000); // 30s timeout for industrial federation tests

// External infrastructure: the remote warehouse Postgres (docker-compose :5436, override with REMOTE_PG_HOST / REMOTE_PG_PORT)
// and MongoDB (docker-compose :27017, override with MONGO_HOST / MONGO_PORT). Suites are skipped, with a one-line reason, when unreachable.
const MONGO = { host: process.env.MONGO_HOST || 'localhost', port: Number(process.env.MONGO_PORT || 27017) };

describeIfRemotePg()('Data Fabric: Multi-Source Federation & Routing (remote Postgres)', () => {
    let token: string;
    const tenantId = uniqueTenantId('msf');
    const registerSource = (name: string, config: any) =>
        request(app).post('/api/admin/connections').set('Authorization', `Bearer ${token}`).send({ name, config });

    /** Catalog entry (schema + table) of a source, seeded the way a crawl would. */
    const seedCatalog = async (sourceName: string, schema: string, table: string) => {
        const src = await pool.query('SELECT id FROM public.data_sources WHERE name = $1 AND tenant_id = $2', [sourceName, tenantId]);
        const schemaRes = await pool.query(
            'INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (source_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
            [src.rows[0].id, schema, schema]
        );
        const tableRes = await pool.query(
            'INSERT INTO public.catalog_tables (schema_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (schema_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
            [schemaRes.rows[0].id, table, table]
        );
        return tableRes.rows[0].id as string;
    };

    beforeAll(async () => {
        token = await createTenantViaApi(await getAdminToken(), tenantId, 'Multi-Source Tenant');
        // Fresh fixture on the remote warehouse every run (repeatable: no duplicate rows).
        await withRemotePg(async (c) => {
            await c.query('DROP TABLE IF EXISTS public.remote_table');
            await c.query('CREATE TABLE public.remote_table (id SERIAL PRIMARY KEY, name TEXT, value INTEGER)');
            await c.query("INSERT INTO public.remote_table (name, value) VALUES ('Remote Item 1', 100), ('Remote Item 2', 200)");
        });
    });

    afterAll(async () => {
        await cleanupTenant(tenantId);
        await withRemotePg((c) => c.query('DROP TABLE IF EXISTS public.remote_table')).catch(() => undefined);
    });

    it('Success: Register Postgres Source (Real Connection)', async () => {
        const res = await registerSource('Remote_PG', remotePgConfig());
        expect([200, 201]).toContain(res.status);
        const check = await pool.query('SELECT id FROM public.data_sources WHERE name = $1 AND tenant_id = $2', ['Remote_PG', tenantId]);
        expect(check.rows.length).toBe(1);
    });

    it('Success: Verify Catalog Hierarchy', async () => {
        const res = await request(app).get('/api/metadata/sources').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.some((s: any) => s.name === 'Remote_PG')).toBe(true);
    });

    it('Success: Query Engine Routes to Remote Postgres', async () => {
        const tableId = await seedCatalog('Remote_PG', 'public', 'remote_table');
        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({ type: 'SELECT', tableId, limit: 1 });

        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
        expect(res.body.data.length).toBe(1);
    });

    describeIfReachable('mongodb', MONGO.host, MONGO.port)('with MongoDB', () => {
        it('Success: Register MongoDB Source (Real Connection)', async () => {
            const res = await registerSource('Mongo_Source', {
                type: 'mongodb', host: MONGO.host, port: MONGO.port, dbName: 'admin', user: 'admin', pass: 'mongo_password', syncType: 'VIRTUAL',
            });
            expect([200, 201]).toContain(res.status);
        });

        it('Success: Query Engine Routes to MongoDB', async () => {
            const tableId = await seedCatalog('Mongo_Source', 'admin', 'system.version');
            const res = await request(app)
                .post('/api/queries/engine')
                .set('Authorization', `Bearer ${token}`)
                .send({ type: 'SELECT', tableId, limit: 1 });

            expect(res.status).toBe(200);
            expect(res.body.data).toBeDefined();
        });

        it('Success: AST federation across engines routes CROSS_ENGINE and merges', async () => {
            // UNION across Remote_PG (Postgres) and Mongo_Source (MongoDB) via the AST path.
            const res = await request(app)
                .post('/api/analytics/query')
                .set('Authorization', `Bearer ${token}`)
                .send({
                    queryConfig: {
                        type: 'SELECT',
                        schema: 'public',
                        limit: 10,
                        query: {
                            union: [
                                { from: { resource: 'remote_table', source: 'Remote_PG' }, select: ['name'] },
                                { from: { resource: 'system.version', source: 'Mongo_Source' }, select: ['version'] },
                            ],
                        },
                    },
                });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
            expect(res.body.plan?.strategy).toBe('CROSS_ENGINE');
        });
    });
});
