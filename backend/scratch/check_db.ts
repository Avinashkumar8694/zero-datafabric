import { pool } from '../src/config/database';

async function checkTenants() {
  try {
    const tenants = await pool.query("SELECT * FROM public.tenants");
    console.log('Tenants:', tenants.rows);
    
    const schemas = await pool.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname LIKE 'tenant_%'");
    console.log('Tenant Schemas:', schemas.rows);
    
    process.exit(0);
  } catch (err) {
    console.error('Check Failed:', err);
    process.exit(1);
  }
}

checkTenants();
