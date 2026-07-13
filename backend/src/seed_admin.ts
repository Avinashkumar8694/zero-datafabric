import { pool } from './config/database';
import { Client } from 'pg';

async function seed() {
    console.log('--- Manual Industrial Seeding ---');
    
    // Register OIDC client inside the identity server database container
    try {
        console.log('Registering OIDC client in zero-identity-server DB...');
        const idsClient = new Client({
            connectionString: 'postgresql://admin:admin123@localhost:5422/identity_server'
        });
        await idsClient.connect();
        await idsClient.query(`
            INSERT INTO client (
                client_id,
                client_secret,
                client_name,
                redirect_uris,
                grant_types,
                response_types,
                requires_consent,
                token_endpoint_auth_method,
                skip_team_check,
                skip_org_check,
                auth_mode
            ) VALUES (
                'zero-datafabric',
                'super-secret-key-fabric',
                'Zero Data Fabric',
                'http://localhost:4000/api/auth/sso/callback',
                'authorization_code,refresh_token',
                'code',
                false,
                'client_secret_post',
                true,
                true,
                'flexible'
            ) ON CONFLICT (client_id) DO UPDATE SET
                redirect_uris = EXCLUDED.redirect_uris,
                token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method
        `);
        await idsClient.end();
        console.log('OIDC client zero-datafabric successfully registered.');
    } catch (idsErr: any) {
        console.warn('[Warning] Could not register OIDC client in zero-identity-server (is it running?):', idsErr.message);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Seed Tenant
        await client.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'System Admin') ON CONFLICT (id) DO NOTHING");
        console.log('Tenant A ensured.');
        
        // 2. Seed Admin User and admin@fabrixly.com
        const passwordHash = '$2b$10$CxBK2AyOtIyt4hCsEZPqEOhGQloahPxyalyChP9hNprweiD/4PZY2'; // 'admin'
        await client.query(
            "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ('admin', $1, 'tenant_A', 'ADMIN') ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
            [passwordHash]
        );
        await client.query(
            "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ('admin@fabrixly.com', $1, 'tenant_A', 'ADMIN') ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
            [passwordHash]
        );
        console.log('Admin users seeded.');

        // 3. Seed Data Sources (Industrial GSC v4.0 Connections)
        const sources = [
            { name: 'Fabric_Hub_Postgres', type: 'POSTGRES', sync_type: 'VIRTUAL', config: { host: 'localhost', port: 5432, user: 'fabric_admin', database: 'datafabric' } },
            { name: 'Activity_Mongo', type: 'MONGODB', sync_type: 'VIRTUAL', config: { uri: 'mongodb://admin:mongo_password@localhost:27017' } },
            { name: 'External_Warehouse', type: 'POSTGRES', sync_type: 'CDC', config: { host: 'localhost', port: 5436, user: 'remote_admin', database: 'remote_warehouse' } },
            { name: 'Elastic_Search', type: 'ELASTICSEARCH', sync_type: 'VIRTUAL', config: { host: 'localhost', port: 9200, connectionString: 'http://localhost:9200' } }
        ];

        for (const s of sources) {
            await client.query(`
                INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status)
                VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
                ON CONFLICT (tenant_id, name) DO UPDATE SET sync_type = EXCLUDED.sync_type, status = 'ACTIVE'
            `, ['tenant_A', s.name, s.type, JSON.stringify(s.config), s.sync_type]);
            console.log(`Source seeded: ${s.name} (${s.sync_type})`);
        }

        await client.query('COMMIT');
        console.log('--- Industrial Seeding Completed Successfully ---');
        process.exit(0);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Seeding failed:', e);
        process.exit(1);
    } finally {
        client.release();
    }
}

seed();
