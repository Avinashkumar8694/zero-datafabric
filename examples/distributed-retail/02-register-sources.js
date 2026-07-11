/**
 * Register the three external databases as datafabric datasources (control-plane
 * metadata only — no test data is written to the fabric DB) and populate the
 * catalog so the QueryPlanner can resolve each logical resource to its physical
 * engine + location.
 *
 * Run:  NODE_PATH=../../backend/node_modules node 02-register-sources.js
 */
const { Client } = require('pg');

const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const TENANT = 'tenant_A';

const SOURCES = [
  {
    name: 'Retail_Core', type: 'POSTGRES', syncType: 'VIRTUAL',
    config: { type: 'postgres', syncType: 'VIRTUAL', host: 'localhost', port: 5436, database: 'retail_core', user: 'remote_admin', password: 'remote_password' },
    schema: { name: 'public', physical: 'public' },
    tables: [
      { name: 'customers', physical: 'customers', type: 'TABLE' },
      { name: 'orders', physical: 'orders', type: 'TABLE' },
      { name: 'v_customer_orders', physical: 'v_customer_orders', type: 'VIEW' },
      { name: 'mv_daily_region_sales', physical: 'mv_daily_region_sales', type: 'MATERIALIZED_VIEW' },
    ],
  },
  {
    name: 'Product_Warehouse', type: 'POSTGRES', syncType: 'VIRTUAL',
    config: { type: 'postgres', syncType: 'VIRTUAL', host: 'localhost', port: 5436, database: 'retail_wh', user: 'remote_admin', password: 'remote_password' },
    schema: { name: 'public', physical: 'public' },
    tables: [
      { name: 'products', physical: 'products', type: 'TABLE' },
      { name: 'order_items', physical: 'order_items', type: 'TABLE' },
    ],
  },
  {
    name: 'Web_Analytics', type: 'MONGODB', syncType: 'VIRTUAL',
    config: { type: 'mongodb', syncType: 'VIRTUAL', uri: 'mongodb://admin:mongo_password@localhost:27017' },
    schema: { name: 'retail', physical: 'retail' },
    tables: [{ name: 'web_events', physical: 'web_events', type: 'TABLE' }],
  },
];

(async () => {
  const c = new Client(HUB);
  await c.connect();
  for (const s of SOURCES) {
    // Upsert the source row.
    let { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, s.name]);
    let sourceId;
    if (rows.length) {
      sourceId = rows[0].id;
      await c.query('UPDATE public.data_sources SET type=$1, sync_type=$2, config=$3, status=$4 WHERE id=$5',
        [s.type, s.syncType, s.config, 'CONNECTED', sourceId]);
    } else {
      const ins = await c.query(
        'INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [TENANT, s.name, s.type, s.config, s.syncType, 'CONNECTED']);
      sourceId = ins.rows[0].id;
    }

    // Rebuild the catalog for this source.
    await c.query('DELETE FROM public.catalog_tables WHERE schema_id IN (SELECT id FROM public.catalog_schemas WHERE source_id=$1)', [sourceId]);
    await c.query('DELETE FROM public.catalog_schemas WHERE source_id=$1', [sourceId]);
    const sch = await c.query('INSERT INTO public.catalog_schemas (source_id, name, physical_name) VALUES ($1,$2,$3) RETURNING id',
      [sourceId, s.schema.name, s.schema.physical]);
    const schemaId = sch.rows[0].id;
    for (const t of s.tables) {
      await c.query('INSERT INTO public.catalog_tables (schema_id, name, physical_name, resource_type) VALUES ($1,$2,$3,$4)',
        [schemaId, t.name, t.physical, t.type]);
    }
    console.log(`registered ${s.name} (${s.type}/${s.syncType}) + ${s.tables.length} catalog objects`);
  }
  await c.end();
  console.log('\nAll three external sources registered + cataloged for tenant_A.');
})().catch((e) => { console.error('REGISTER FAILED:', e); process.exit(1); });
