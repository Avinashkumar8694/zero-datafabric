import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { getAdminToken, cleanupTenant, createTenantViaApi, uniqueTenantId, describeIfRemotePg, REMOTE_PG } from './test_helper';

jest.setTimeout(30000);

const MONGO_DSN = process.env.TEST_MONGO_URI;
if (!MONGO_DSN) process.stderr.write('[skip] TEST_MONGO_URI not set; MongoDB connection-string tests are skipped\n');

describe('Advanced Data Source Features: Connection Strings & Dynamic Settings', () => {
    let adminToken: string;
    const tenantId = uniqueTenantId('adv');

    beforeAll(async () => {
        adminToken = await createTenantViaApi(await getAdminToken(), tenantId, 'Advanced Test Tenant');
    });

    afterAll(async () => {
        await cleanupTenant(tenantId);
    });

    // The remote warehouse Postgres is external infrastructure (docker-compose :5436, or REMOTE_PG_HOST / REMOTE_PG_PORT).
    describeIfRemotePg()('remote warehouse', () => {
        it('Success: Register PostgreSQL via Connection String', async () => {
            const dsn = `postgresql://${REMOTE_PG.user}:${REMOTE_PG.pass}@${REMOTE_PG.host}:${REMOTE_PG.port}/${REMOTE_PG.dbName}`;
            const res = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    name: 'PG_DSN_Source',
                    config: { type: 'postgres', connectionString: dsn, syncType: 'VIRTUAL' }
                });

            expect(res.status).toBe(201);
            expect(res.body.status).toBe('INTEGRATED');

            // The stored config keeps the DSN (secrets are only redacted on the way out, see isolation/connection-secrets).
            const check = await pool.query('SELECT config FROM public.data_sources WHERE id = $1', [res.body.sourceId]);
            expect(check.rows[0].config.connectionString).toBe(dsn);
        });

        it('Success: Register Data Source with Dynamic Options', async () => {
            const res = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    name: 'Dynamic_Source',
                    config: {
                        type: 'postgres',
                        host: REMOTE_PG.host,
                        port: REMOTE_PG.port,
                        dbName: REMOTE_PG.dbName,
                        user: REMOTE_PG.user,
                        pass: REMOTE_PG.pass,
                        syncType: 'VIRTUAL',
                        advanced: {
                            dynamicOptions: {
                                application_name: 'DataFabric_Test',
                                search_path: 'public',
                                custom_param: 'some_value'
                            }
                        }
                    }
                });

            expect(res.status).toBe(201);
            expect(res.body.status).toBe('INTEGRATED');

            const check = await pool.query('SELECT config FROM public.data_sources WHERE id = $1', [res.body.sourceId]);
            expect(check.rows[0].config.advanced.dynamicOptions.application_name).toBe('DataFabric_Test');
        });
    });

    it('Security: the hub database cannot be registered as a data source', async () => {
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Hub_Self',
                config: { type: 'postgres', host: '127.0.0.1', port: 5434, dbName: 'datafabric', user: 'fabric_admin', pass: 'x', syncType: 'VIRTUAL' }
            });
        expect(res.status).toBe(403);
    });

    // MongoDB connection-string tests need a reachable MongoDB / Atlas cluster. The DSN is supplied by the environment
    // (TEST_MONGO_URI, e.g. mongodb://admin:...@localhost:27017/admin?authSource=admin); no credential is kept in the repository.
    (MONGO_DSN ? describe : describe.skip)('MongoDB connection strings (TEST_MONGO_URI)', () => {
        it('Success: Register MongoDB via Connection String', async () => {
            const dsn = MONGO_DSN as string;
            const res = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    name: 'Mongo_Atlas_Source',
                    config: {
                        type: 'mongodb',
                        connectionString: dsn,
                        syncType: 'VIRTUAL'
                    }
                });
        
            expect(res.status).toBe(201);
            expect(res.body.status).toBe('INTEGRATED');
        });

        it('Success: Discovery & Query using Connection String Source', async () => {
            // Register a Mongo source via DSN and try to crawl it
            const dsn = MONGO_DSN as string;
            const reg = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${adminToken}`)
                .send({
                    name: 'Mongo_Atlas_Discovery',
                    config: {
                        type: 'mongodb',
                        connectionString: dsn,
                        syncType: 'VIRTUAL'
                    }
                });
        
            const sourceId = reg.body.sourceId;

            // Crawl
            const crawl = await request(app)
                .post(`/api/metadata/crawl`)
                .set('Authorization', `Bearer ${adminToken}`)
                .send({ tenantId });
        
            expect(crawl.status).toBe(200);
            expect(crawl.body.sourceResults.some((s: any) => s.sourceId === sourceId)).toBeTruthy();
        });

    });
});
