import { Client } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function test() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });
    await client.connect();
    try {
        const tenantId = 'apply_test_tenant';
        const schemaName = `tenant_${tenantId}`;
        
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
        await client.query(`CREATE TABLE IF NOT EXISTS "${schemaName}"."users" (id SERIAL PRIMARY KEY, email TEXT, status TEXT)`);
        
        const viewSql = `CREATE VIEW "${schemaName}"."v_active_users" AS SELECT id, email FROM "${schemaName}"."users" WHERE status = 'ACTIVE'`;
        console.log('Executing:', viewSql);
        await client.query(viewSql);
        console.log('Success!');
    } catch (err: any) {
        console.error('Error:', err.message);
    } finally {
        await client.end();
    }
}

test().catch(console.error);
