/**
 * Register the Reviews_ES datasource (control-plane metadata only) + catalog so
 * the planner resolves `product_reviews` to the Elasticsearch index.
 * Run:  NODE_PATH=../../backend/node_modules node 02-register.js
 */
const { Client } = require('pg');
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const TENANT = 'tenant_A';
const SRC = {
  name: 'Reviews_ES', type: 'ELASTICSEARCH', syncType: 'VIRTUAL',
  config: { type: 'elasticsearch', syncType: 'VIRTUAL', uri: 'http://localhost:9200' },
  schema: { name: 'default', physical: 'default' },
  tables: [{ name: 'product_reviews', physical: 'product_reviews', type: 'TABLE' }],
};

(async () => {
  const c = new Client(HUB);
  await c.connect();
  let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, SRC.name]);
  let sourceId;
  if (rows.length) {
    sourceId = rows[0].id;
    await c.query('UPDATE public.data_sources SET type=$1, sync_type=$2, config=$3, status=$4 WHERE id=$5', [SRC.type, SRC.syncType, SRC.config, 'CONNECTED', sourceId]);
  } else {
    const ins = await c.query('INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [TENANT, SRC.name, SRC.type, SRC.config, SRC.syncType, 'CONNECTED']);
    sourceId = ins.rows[0].id;
  }
  await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sourceId]);
  await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sourceId]);
  const sch = await c.query('INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1,$2,$3) RETURNING id', [sourceId, SRC.schema.name, SRC.schema.physical]);
  for (const t of SRC.tables) await c.query('INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type) VALUES ($1,$2,$3,$4)', [sch.rows[0].id, t.name, t.physical, t.type]);
  await c.end();
  console.log(`registered ${SRC.name} → product_reviews (Elasticsearch) for tenant_A`);
})().catch((e) => { console.error('REGISTER FAILED:', e.message || e); process.exit(1); });
