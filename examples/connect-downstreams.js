/* eslint-disable no-console */
/**
 * Seed the downstream/search connections so they appear in the Connections page
 * and the Settings → Downstream Control Center:
 *   - Elasticsearch (live, from docker infra on :9200)
 *   - Snowflake (placeholder connection — marked PENDING until real creds are set)
 *
 * Run:  NODE_PATH=backend/node_modules node examples/connect-downstreams.js
 */
const { Client } = require('pg');
const HUB = { host: 'localhost', port: 5434, user: 'fabric_admin', password: 'fabric_password', database: 'datafabric' };
const TENANT = process.env.TENANT_ID || 'tenant_A';

const CONNECTIONS = [
  {
    name: 'Elastic_Search', type: 'ELASTICSEARCH', sync_type: 'VIRTUAL', status: 'CONNECTED',
    config: { type: 'elasticsearch', host: 'localhost', port: 9200, node: 'http://localhost:9200', connectionString: 'http://localhost:9200' },
  },
  {
    name: 'Snowflake_Warehouse', type: 'SNOWFLAKE', sync_type: 'CDC', status: 'PENDING',
    config: { type: 'snowflake', account: '<account>', warehouse: '<warehouse>', database: '<db>', role: '<role>', note: 'set real credentials to activate' },
  },
];

(async () => {
  const c = new Client(HUB); await c.connect();
  for (const s of CONNECTIONS) {
    const { rows } = await c.query('SELECT id FROM public.data_sources WHERE tenant_id=$1 AND name=$2', [TENANT, s.name]);
    if (rows.length) {
      await c.query('UPDATE public.data_sources SET type=$1, sync_type=$2, config=$3, status=$4 WHERE id=$5',
        [s.type, s.sync_type, s.config, s.status, rows[0].id]);
      console.log(`updated connection ${s.name} (${s.type}/${s.status})`);
    } else {
      await c.query('INSERT INTO public.data_sources (tenant_id, name, type, config, sync_type, status) VALUES ($1,$2,$3,$4,$5,$6)',
        [TENANT, s.name, s.type, s.config, s.sync_type, s.status]);
      console.log(`registered connection ${s.name} (${s.type}/${s.status})`);
    }
  }
  await c.end();
  // This seed writes straight to the DB (bypassing the app), so bust the metadata
  // cache — otherwise a stale `meta:<tenant>:sources` hides the new connections in
  // the UI (Connections page, AST builder source list) until the TTL expires.
  try {
    const Redis = require('ioredis');
    const r = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
    await r.connect();
    const keys = await r.keys(`meta:${TENANT}:*`);
    if (keys.length) await r.del(keys);
    await r.quit();
    console.log(`flushed ${keys.length} stale cache key(s) for ${TENANT}`);
  } catch (e) { console.warn(`cache flush skipped: ${e.message}`); }
  console.log(`\nDone. Elasticsearch + Snowflake connections registered for ${TENANT}. They now appear in Connections and Settings → Downstream Control Center.`);
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
