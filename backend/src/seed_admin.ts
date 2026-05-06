import { pool } from './config/database';

async function seed() {
    console.log('--- Manual Admin Seeding ---');
    try {
        await pool.query("INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'System Admin') ON CONFLICT (id) DO NOTHING");
        console.log('Tenant A ensured.');
        
        const passwordHash = '$2b$10$CxBK2AyOtIyt4hCsEZPqEOhGQloahPxyalyChP9hNprweiD/4PZY2'; // 'admin'
        await pool.query(
            "INSERT INTO public.users (username, password_hash, tenant_id, role) VALUES ('admin', $1, 'tenant_A', 'ADMIN') ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash",
            [passwordHash]
        );
        console.log('Admin user seeded.');
        process.exit(0);
    } catch (e) {
        console.error('Seeding failed:', e);
        process.exit(1);
    }
}

seed();
