import pool from '../config/db';

export const createTenant = async (tenantName: string) => {
  const tenantId = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  await pool.query('INSERT INTO tenants (id, name) VALUES (uuid_generate_v4(), $1)', [tenantName]);
  await pool.query('SELECT admin_functions.create_tenant_schema($1)', [tenantId]);
  
  return { tenantId, schema: `tenant_${tenantId}` };
};

export const createConnection = async (data: any) => {
  const { tenantId, serverName, host, port, dbname, remoteUser, remotePassword } = data;
  const targetSchema = `tenant_${tenantId}`;
  
  await pool.query(
    'SELECT admin_functions.register_remote_postgres($1, $2, $3, $4, $5, $6, $7)',
    [serverName, host, port, dbname, remoteUser, remotePassword, targetSchema]
  );
  
  await pool.query(
    'INSERT INTO data_sources (tenant_id, source_name, source_type, connection_uri) VALUES ($1, $2, $3, $4)',
    [tenantId, serverName, 'postgres', `postgres://${remoteUser}:***@${host}:${port}/${dbname}`]
  );
  
  return { message: 'Virtual Data Source Connected Successfully' };
};
