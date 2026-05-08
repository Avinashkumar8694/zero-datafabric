import { pool } from '../src/config/database';

async function check() {
    const res = await pool.query('SELECT * FROM "tenant_query_test_a"."data_a"');
    console.log('Total Rows as Admin:', res.rows.length);
    console.log('Rows:', JSON.stringify(res.rows, null, 2));
    process.exit(0);
}

check();
