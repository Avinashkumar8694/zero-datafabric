import { pool } from '../src/config/database';

async function check() {
    const client = await pool.connect();
    try {
        await client.query('SET ROLE fabric_user');
        // We also need app.tenant_id if RLS was active, but here it's USING(true)
        const res = await client.query('SELECT * FROM "tenant_query_test_a"."data_a"');
        console.log('Total Rows as User:', res.rows.length);
        console.log('Rows:', JSON.stringify(res.rows, null, 2));
    } catch (e: any) {
        console.error('Error as User:', e.message);
    } finally {
        client.release();
    }
    process.exit(0);
}

check();
