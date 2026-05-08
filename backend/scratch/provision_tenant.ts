import { pool } from '../src/config/database';

async function provision() {
  try {
    await pool.query("SELECT fabric_admin.create_tenant_namespace('tenant_A')");
    console.log('Namespace provisioned for tenant_A');
    process.exit(0);
  } catch (err) {
    console.error('Provisioning Failed:', err);
    process.exit(1);
  }
}

provision();
