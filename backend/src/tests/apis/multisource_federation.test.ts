import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';

jest.setTimeout(30000); // 30s timeout for industrial federation tests

describe('Data Fabric: Multi-Source Federation & Routing', () => {
    let token: string;
    let tenantId = 'tenant_multisource';

    beforeAll(async () => {
        // Clean up
        await pool.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1))', [tenantId]);
        await pool.query('DELETE FROM public.catalog_schemas WHERE source_id IN (SELECT id FROM public.data_sources WHERE tenant_id = $1)', [tenantId]);
        await pool.query('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
        
        // Create Tenant and Provision Namespace
        await pool.query('INSERT INTO public.tenants (id, name, status) VALUES ($1, $2, $3)', [tenantId, 'Multi-Source Tenant', 'ACTIVE']);
        await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [tenantId]);
        
        // SEED REMOTE DB (datafabric-remote)
        const { Client } = require('pg');
        const remoteClient = new Client({
            host: 'localhost',
            port: 5436,
            database: 'remote_warehouse',
            user: 'remote_admin',
            password: 'remote_password'
        });
        await remoteClient.connect();
        await remoteClient.query('CREATE TABLE IF NOT EXISTS public.remote_table (id SERIAL PRIMARY KEY, name TEXT, value INTEGER)');
        await remoteClient.query("INSERT INTO public.remote_table (name, value) VALUES ('Remote Item 1', 100), ('Remote Item 2', 200)");
        await remoteClient.end();

        token = AuthService.generateToken(tenantId, 'ADMIN', 'admin');
    });

    it('Success: Register Heterogeneous Sources (Real Connections)', async () => {
        const sources = [
            { 
                name: 'Remote_PG', 
                type: 'postgres', 
                host: 'localhost', 
                port: 5436, 
                dbName: 'remote_warehouse', 
                user: 'remote_admin', 
                pass: 'remote_password',
                syncType: 'VIRTUAL' 
            },
            { 
                name: 'Mongo_Source', 
                type: 'mongodb', 
                host: 'localhost', 
                port: 27017, 
                dbName: 'admin', 
                user: 'admin', 
                pass: 'mongo_password',
                syncType: 'VIRTUAL' 
            }
        ];

        for (const s of sources) {
            const res = await request(app)
                .post('/api/admin/connections')
                .set('Authorization', `Bearer ${token}`)
                .send({
                    name: s.name,
                    config: {
                        type: s.type,
                        host: s.host,
                        port: s.port,
                        dbName: s.dbName,
                        user: s.user,
                        pass: s.pass,
                        syncType: s.syncType
                    }
                });
            
            expect([200, 201]).toContain(res.status);
            
            // Check existence in DB
            const check = await pool.query("SELECT id FROM public.data_sources WHERE name = $1 AND tenant_id = $2", [s.name, tenantId]);
            expect(check.rows.length).toBe(1);
        }
    });

    it('Success: Verify Catalog Hierarchy', async () => {
        const res = await request(app)
            .get('/api/metadata/sources')
            .set('Authorization', `Bearer ${token}`);
        
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThanOrEqual(2);
    });

    it('Success: Query Engine Routes to Remote Postgres', async () => {
        const sources = await pool.query("SELECT id FROM public.data_sources WHERE type = 'postgres' AND name = 'Remote_PG' AND tenant_id = $1", [tenantId]);
        const sourceId = sources.rows[0].id;

        // Ensure we have catalog metadata (Normally handled by crawl, but we can seed it for test)
        const schemaRes = await pool.query(
            "INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (source_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
            [sourceId, 'public', 'public']
        );
        const tableRes = await pool.query(
            "INSERT INTO public.catalog_tables (schema_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (schema_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
            [schemaRes.rows[0].id, 'remote_table', 'remote_table']
        );

        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({
                type: 'SELECT',
                tableId: tableRes.rows[0].id,
                limit: 1
            });
        
        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
    });

    it('Success: Query Engine Routes to MongoDB', async () => {
        const sources = await pool.query("SELECT id FROM public.data_sources WHERE type = 'mongodb' AND tenant_id = $1", [tenantId]);
        const sourceId = sources.rows[0].id;

        const schemaRes = await pool.query(
            "INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (source_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
            [sourceId, 'admin', 'admin']
        );
        const tableRes = await pool.query(
            "INSERT INTO public.catalog_tables (schema_id, name, physical_name) VALUES ($1, $2, $3) ON CONFLICT (schema_id, physical_name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
            [schemaRes.rows[0].id, 'system.version', 'system.version']
        );

        const res = await request(app)
            .post('/api/queries/engine')
            .set('Authorization', `Bearer ${token}`)
            .send({
                type: 'SELECT',
                tableId: tableRes.rows[0].id,
                limit: 1
            });
        
        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
    });

    it('Success: AST federation across engines routes CROSS_ENGINE and merges', async () => {
        // UNION across Remote_PG (Postgres) and Mongo_Source (MongoDB) via the AST path,
        // exercising the planner + FederationExecutor over HTTP (previously uncovered).
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
