import { pool } from '../src/config/database';

async function list() {
    const schemas = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'tenant_q_test_a_%' ORDER BY schema_name DESC LIMIT 1");
    if (schemas.rows.length === 0) {
        console.log('No tenant schemas found');
        process.exit(1);
    }
    const schema = schemas.rows[0].schema_name;
    console.log('Checking Schema:', schema);

    const res = await pool.query(`
        SELECT relname, relrowsecurity, relforcerowsecurity 
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}' AND c.relname = 'data_a'
    `);
    console.log('RLS Status:', JSON.stringify(res.rows, null, 2));

    const policies = await pool.query(`
        SELECT polname, polcmd, polroles, polqual 
        FROM pg_policy 
        WHERE polrelid = '"${schema}"."data_a"'::regclass
    `);
    console.log('Policies:', JSON.stringify(policies.rows, null, 2));
    process.exit(0);
}

list();
