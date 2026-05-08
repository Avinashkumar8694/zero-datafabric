import pool from '../config/db';

export const createTenant = async (tenantName: string) => {
  const tenantId = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  
  await pool.query('INSERT INTO tenants (id, name) VALUES (uuid_generate_v4(), $1)', [tenantName]);
  await pool.query('SELECT fabric_admin.create_tenant_namespace($1)', [tenantId]);
  
  return { tenantId, schema: `tenant_${tenantId}` };
};

export const createConnection = async (data: any) => {
  const { tenantId, serverName, host, port, dbname, remoteUser, remotePassword } = data;
  
  await pool.query(
    'SELECT fabric_admin.register_remote_source($1, $2, $3, $4, $5, $6, $7)',
    [tenantId, serverName, host, port, dbname, remoteUser, remotePassword]
  );
  
  await pool.query(
    'INSERT INTO data_sources (tenant_id, name, type, config, status) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, serverName, 'postgres', JSON.stringify({ host, port, dbname, user: remoteUser }), 'CONNECTED']
  );
  
  return { message: 'Virtual Data Source Connected Successfully' };
};

export const disconnectSource = async (sourceId: string, status: string) => {
  await pool.query(
    'UPDATE data_sources SET status = $1 WHERE id = $2',
    [status, sourceId]
  );
  return { message: `Source status updated to ${status}` };
};

export const removeConnection = async (sourceId: string) => {
  // 1. Get metadata for cleanup
  const res = await pool.query('SELECT tenant_id, name FROM data_sources WHERE id = $1', [sourceId]);
  if (res.rows.length === 0) throw new Error('Source not found');
  
  const { tenant_id, name } = res.rows[0];

  // 2. Deregister from Postgres (FDW cleanup)
  await pool.query('SELECT fabric_admin.remove_remote_source($1, $2)', [tenant_id, name]);

  // 3. Remove metadata entries
  await pool.query('DELETE FROM fabric_catalog.metadata WHERE source_id = $1', [sourceId]);

  // 4. Remove from registry
  await pool.query('DELETE FROM data_sources WHERE id = $1', [sourceId]);

  return { message: 'Data Source and all associated metadata purged successfully' };
};
export const getConnections = async (tenantId?: string) => {
  let query = 'SELECT * FROM data_sources';
  const params = [];
  
  if (tenantId) {
    query += ' WHERE tenant_id = $1';
    params.push(tenantId);
  }
  
  const res = await pool.query(query, params);
  return res.rows;
};
