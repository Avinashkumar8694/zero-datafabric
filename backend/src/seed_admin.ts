import { pool } from './config/database';
import { Client } from 'pg';

async function seed() {
    console.log('--- Manual Industrial Seeding ---');
    
    // Register OIDC client inside the identity server database
    try {
        console.log('Registering OIDC client in zero-identity-server DB...');
        // IDS DB connection — use env var or fallback for local dev
        const idsConnStr = process.env.IDS_DB_URL || 'postgresql://zero_db_admin:admin@zero-identity-server-postgres-1:5432/identity_server';
        const idsClient = new Client({ connectionString: idsConnStr });
        await idsClient.connect();

        // Build redirect URIs: always include both production and localhost
        const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
        const prodCallback = `${apiBase}/api/auth/sso/callback`;
        const redirectUris = [
            prodCallback,
            'http://localhost:4000/api/auth/sso/callback',
        ].filter((v, i, a) => a.indexOf(v) === i).join(',');

        const uiBase = process.env.UI_BASE_URL || 'http://localhost:3006';
        const logoutUris = [
            uiBase,
            `${uiBase}/`,
            'http://localhost:3006',
            'http://localhost:3006/',
            'http://localhost:3001',
            'http://localhost:3001/',
            'http://localhost:3000',
            'http://localhost:3000/'
        ].filter((v, i, a) => a.indexOf(v) === i).join(',');

        const clientSecret = process.env.OIDC_CLIENT_SECRET || 'super-secret-key-fabric';

        await idsClient.query(`
            INSERT INTO client (
                client_id,
                client_secret,
                client_name,
                redirect_uris,
                post_logout_redirect_uris,
                grant_types,
                response_types,
                requires_consent,
                token_endpoint_auth_method,
                skip_team_check,
                skip_org_check,
                auth_mode
            ) VALUES (
                'zero-datafabric',
                $1,
                'Zero Data Fabric',
                $2,
                $3,
                'authorization_code,refresh_token',
                'code',
                false,
                'client_secret_post',
                true,
                true,
                'flexible'
            ) ON CONFLICT (client_id) DO UPDATE SET
                redirect_uris = EXCLUDED.redirect_uris,
                post_logout_redirect_uris = EXCLUDED.post_logout_redirect_uris,
                client_secret = EXCLUDED.client_secret,
                token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method
        `, [clientSecret, redirectUris, logoutUris]);
        await idsClient.end();
        console.log(`OIDC client zero-datafabric registered with redirect: ${redirectUris}`);
    } catch (idsErr: any) {
        console.warn('[Warning] Could not register OIDC client in zero-identity-server (is it running?):', idsErr.message);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Seed Tenant
        await client.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'System Admin') ON CONFLICT (id) DO NOTHING");
        console.log('Tenant A ensured.');
        
        // 2. Seed Admin and Local Test Users
        const adminHash = '$2b$10$N8CKyrZ43RVNuuuaUetvOeQlCKkKIf8HQ5uyy.O4.7uBLoXmGVgH6'; // 'admin123'
        const userHash = '$2b$10$NJbOuJohycpXKstBzrHkJOwFlx3dUd/yg1uOe4zLwAAWzpFggb3Nu';  // 'password123'

        const usersToSeed = [
            { username: 'admin', passwordHash: adminHash, role: 'ADMIN' },
            { username: 'admin@fabrixly.com', passwordHash: adminHash, role: 'ADMIN' },
            { username: 'arjunkumargupta108@gmail.com', passwordHash: adminHash, role: 'ADMIN' },
            { username: 'developer', passwordHash: userHash, role: 'USER' },
            { username: 'developer@fabrixly.com', passwordHash: userHash, role: 'USER' },
            { username: 'analyst', passwordHash: userHash, role: 'USER' },
            { username: 'analyst@fabrixly.com', passwordHash: userHash, role: 'USER' },
            { username: 'demo_user', passwordHash: userHash, role: 'USER' },
            { username: 'demo@fabrixly.com', passwordHash: userHash, role: 'USER' },
        ];

        for (const u of usersToSeed) {
            await client.query(
                `INSERT INTO public.users (username, password_hash, tenant_id, role)
                 VALUES ($1, $2, 'tenant_A', $3)
                 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, tenant_id = 'tenant_A'`,
                [u.username, u.passwordHash, u.role]
            );
        }
        console.log(`Seeded ${usersToSeed.length} local login users.`);

        const adminRes = await client.query("SELECT id FROM public.users WHERE username = 'admin'");
        const adminEmailRes = await client.query("SELECT id FROM public.users WHERE username = 'admin@fabrixly.com'");
        const adminArjunRes = await client.query("SELECT id FROM public.users WHERE username = 'arjunkumargupta108@gmail.com'");

        const adminId = adminRes.rows[0]?.id;
        const adminEmailId = adminEmailRes.rows[0]?.id;
        const adminArjunId = adminArjunRes.rows[0]?.id;

        // Associate user_id with the 'tenant_A' tenant registry record
        await client.query("UPDATE public.tenants SET user_id = $1 WHERE id = 'tenant_A'", [adminId]);

        // Seed SelfHost subscription for admin users to enable self-hosted native login
        const selfhostPlan = await client.query("SELECT id FROM public.plans WHERE name = 'selfhost'");
        if (selfhostPlan.rows.length > 0) {
            const planId = selfhostPlan.rows[0].id;
            for (const uid of [adminId, adminEmailId, adminArjunId]) {
                if (uid) {
                    await client.query(
                        `INSERT INTO public.subscriptions (user_id, plan_id, status)
                         VALUES ($1, $2, 'active')
                         ON CONFLICT (user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active'`,
                        [uid, planId]
                    );
                }
            }
            console.log('Selfhost subscriptions seeded for admin users.');
        }

        // Seed custom_login settings (enabling Data Fabric native password login + SSO)
        await client.query(`
            INSERT INTO public.settings (key, value)
            VALUES ('custom_login', $1)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [JSON.stringify({
            title: "Zero Data Fabric",
            logo_url: "",
            bg_color: "#04060f",
            allow_password_login: true,
            sso_enabled: true,
            oidc_issuer: "https://ids.fabrixly.com/oidc",
            oidc_client_id: "zero-datafabric"
        })]);
        console.log('Custom login settings configured (allow_password_login: true).');

        // 3. Seed Data Sources (Industrial GSC v4.0 Connections)
        const sources = [
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
