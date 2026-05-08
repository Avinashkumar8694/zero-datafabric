import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { AuthService } from '../../modules/auth/auth.service';

jest.setTimeout(30000);

describe('Advanced Data Source Features: Connection Strings & Dynamic Settings', () => {
    let adminToken: string;
    const tenantId = 'tenant_advanced_test';

    beforeAll(async () => {
        // Cleanup and Setup
        await pool.query('DROP SCHEMA IF EXISTS tenant_tenant_advanced_test CASCADE');
        await pool.query('DELETE FROM public.data_sources WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
        await pool.query('INSERT INTO public.tenants (id, name, status) VALUES ($1, $2, $3)', [tenantId, 'Advanced Test Tenant', 'ACTIVE']);
        await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [tenantId]);
        
        adminToken = AuthService.generateToken(tenantId, 'ADMIN', 'admin');
    });

    it('Success: Register PostgreSQL via Connection String', async () => {
        const dsn = 'postgresql://remote_admin:remote_password@127.0.0.1:5436/remote_warehouse';
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'PG_DSN_Source',
                config: {
                    type: 'postgres',
                    connectionString: dsn,
                    syncType: 'VIRTUAL'
                }
            });
        
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('INTEGRATED');
        
        // Verify FDW mapping (if applicable) - in this case, it should have been registered
        const check = await pool.query("SELECT config FROM public.data_sources WHERE id = $1", [res.body.sourceId]);
        expect(check.rows[0].config.connectionString).toBe(dsn);
    });

    it('Success: Register MongoDB via Atlas Connection String', async () => {
        const dsn = 'mongodb+srv://kumarAviNit:OmbHwoeeRSJ3LjQb@clusterecommerce.x2x0e.mongodb.net/?appName=ClusterEcommerce';
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

    it('Success: Register Data Source with Dynamic Options', async () => {
        const res = await request(app)
            .post('/api/admin/connections')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Dynamic_Source',
                config: {
                    type: 'postgres',
                    host: '127.0.0.1',
                    port: 5434,
                    dbName: 'datafabric',
                    user: 'fabric_admin',
                    pass: 'fabric_password',
                    syncType: 'VIRTUAL',
                    advanced: {
                        dynamicOptions: {
                            application_name: 'DataFabric_Test',
                            search_path: 'public,fabric_admin',
                            custom_param: 'some_value'
                        }
                    }
                }
            });
        
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('INTEGRATED');
        
        const check = await pool.query("SELECT config FROM public.data_sources WHERE id = $1", [res.body.sourceId]);
        expect(check.rows[0].config.advanced.dynamicOptions.application_name).toBe('DataFabric_Test');
    });

    it('Success: Discovery & Query using Connection String Source', async () => {
        // Register a Mongo source via DSN and try to crawl it
        const dsn = 'mongodb+srv://kumarAviNit:OmbHwoeeRSJ3LjQb@clusterecommerce.x2x0e.mongodb.net/?appName=ClusterEcommerce';
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
