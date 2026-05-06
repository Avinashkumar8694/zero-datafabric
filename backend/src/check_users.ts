import { pool } from './config/database';

async function check() {
    try {
        const { rows } = await pool.query('SELECT username, role, tenant_id FROM public.users');
        console.log('--- Users in DB ---');
        console.table(rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
