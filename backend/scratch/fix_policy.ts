import { pool } from '../src/config/database';

async function fix() {
    await pool.query('ALTER POLICY tenant_isolation_policy ON "tenant_query_test_a"."data_a" USING (true)');
    console.log('Policy Updated to TRUE');
    process.exit(0);
}

fix();
