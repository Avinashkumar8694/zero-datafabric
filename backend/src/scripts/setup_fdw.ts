import { pool } from '../config/database';

async function setup() {
  const client = await pool.connect();
  try {
    console.log('--- Initializing Global Virtualization Layer ---');
    
    // 1. Enable FDW Extension
    await client.query('CREATE EXTENSION IF NOT EXISTS postgres_fdw');
    console.log('[OK] postgres_fdw enabled');

    // 2. Create Foreign Server
    // Note: 'remote_db' is the docker-compose service name
    await client.query(`
      CREATE SERVER IF NOT EXISTS remote_warehouse_server
      FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host 'remote_db', port '5432', dbname 'remote_warehouse')
    `);
    console.log('[OK] Foreign Server "remote_warehouse_server" created');

    // 3. Create User Mapping
    // Map the local 'fabric_admin' to remote 'remote_admin'
    await client.query(`
      CREATE USER MAPPING IF NOT EXISTS FOR fabric_admin
      SERVER remote_warehouse_server
      OPTIONS (user 'remote_admin', password 'remote_password')
    `);
    console.log('[OK] User Mapping established');

    // 4. Create a Foreign Table for a test tenant (e.g. tenant123)
    await client.query('CREATE SCHEMA IF NOT EXISTS "tenant_tenant123"');
    await client.query(`
      CREATE FOREIGN TABLE IF NOT EXISTS "tenant_tenant123"."remote_inventory" (
        id INTEGER,
        sku VARCHAR(100),
        qty INTEGER
      )
      SERVER remote_warehouse_server
      OPTIONS (schema_name 'public', table_name 'remote_inventory')
    `);
    console.log('[OK] Virtual Table "remote_inventory" mapped to Tenant "tenant123"');

    console.log('--- Virtualization Orchestration Complete ---');
  } catch (err: any) {
    console.error('[ERROR] FDW Setup failed:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

setup();
