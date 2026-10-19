/* eslint-disable no-console */
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const axios = require('axios');
const { Client } = require('../backend/node_modules/pg');
const { BASE_URL, TENANT_ID, login, authHeaders, call, banner } = require('./_client');

const MANIFEST = process.env.MANIFEST_FILE || 'test_manifest.json';

function applyManifestCurl(token, force) {
  const q = force ? '?force=true' : '';
  const cmd = [
    `curl -s -X POST "${BASE_URL}/metadata/apply${q}"`,
    `-H "Authorization: Bearer ${token}"`,
    `-H "x-tenant-id: ${TENANT_ID}"`,
    `-F "file=@${MANIFEST}"`
  ].join(' ');
  return execSync(cmd, { encoding: 'utf8' });
}

async function main() {
  banner('Prepare Demo Environment');
  if (!fs.existsSync(MANIFEST)) throw new Error(`Manifest not found: ${MANIFEST}`);
  const token = await login();
  const headers = authHeaders(token);

  await call('Register 3 sources', async () => {
    const payloads = [
      { name: 'Fabric_Hub_Postgres', config: { type: 'postgres', host: 'localhost', port: 5436, dbName: 'remote_warehouse', user: 'remote_admin', pass: 'remote_password', syncType: 'VIRTUAL' } },
      { name: 'Activity_Mongo', config: { type: 'mongodb', host: 'localhost', port: 27017, dbName: 'admin', user: 'admin', pass: 'mongo_password', syncType: 'VIRTUAL' } },
      { name: 'Elastic_Search', config: { type: 'elasticsearch', host: 'localhost', port: 9200, connectionString: 'http://localhost:9200', syncType: 'VIRTUAL' } }
    ];
    for (const p of payloads) {
      try { await axios.post(`${BASE_URL}/admin/connections`, p, { headers }); } catch (_) {}
    }
    return { data: { ok: true } };
  });

  await call('Apply manifest (force)', async () => {
    const raw = applyManifestCurl(token, true);
    const data = JSON.parse(raw || '{}');
    return { data };
  }, { allowFail: true });

  // Direct admin-level DB preparation to ensure examples can mutate (grants + demo tables)
  await call('Admin DB grants/seeding preparation', async () => {
    const hubUrl = 'postgresql://fabric_admin:fabric_password@localhost:5434/datafabric';
    const remoteUrl = 'postgresql://remote_admin:remote_password@localhost:5436/remote_warehouse';

    // 1. Create schemas and tables on the remote/external database
    const remoteClient = new Client({ connectionString: remoteUrl });
    await remoteClient.connect();
    const rootSchema = `tenant_${TENANT_ID}_Global_Supply_Chain`;
    const logSchema = `tenant_${TENANT_ID}_Activity_Logs`;
    const extSchema = `tenant_${TENANT_ID}_External_Archive`;

    const remoteSql = `
      CREATE SCHEMA IF NOT EXISTS "${rootSchema}";
      CREATE SCHEMA IF NOT EXISTS "${logSchema}";
      CREATE SCHEMA IF NOT EXISTS "${extSchema}";

      CREATE TABLE IF NOT EXISTS "${rootSchema}"."employees" ("id" uuid primary key, "name" text, "manager_id" uuid);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."shipments" ("id" uuid primary key, "region" text, "status" text, "total_amount" numeric);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."shipment_details" ("id" uuid primary key, "shipment_id" uuid REFERENCES "${rootSchema}"."shipments"(id), "notes" text);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."local_inventory" ("sku" text, "stock" int);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."remote_depot_mongo" ("item_id" text, "qty" int);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."active_products" ("sku" text);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."mongo_product_catalog" ("product_id" text);
      CREATE TABLE IF NOT EXISTS "${rootSchema}"."quarantined_items" ("sku" text);
      CREATE TABLE IF NOT EXISTS "${logSchema}"."shipment_audit_logs" ("shipment_id" uuid, "event_type" text, "payload" jsonb);
      CREATE TABLE IF NOT EXISTS "${logSchema}"."user_activity" ("user_id" uuid, "action" text, "timestamp" timestamp);
      CREATE TABLE IF NOT EXISTS "${extSchema}"."global_tags" ("id" uuid primary key, "tag_name" text);
      CREATE SEQUENCE IF NOT EXISTS "${rootSchema}"."tracking_seq" START 100000;

      CREATE OR REPLACE VIEW "${rootSchema}"."federated_inventory_analysis" AS
      SELECT sku, stock AS qty FROM "${rootSchema}"."local_inventory"
      UNION ALL
      SELECT item_id AS sku, qty FROM "${rootSchema}"."remote_depot_mongo";

      CREATE OR REPLACE PROCEDURE "${rootSchema}"."process_delivery"() AS $$
      BEGIN
        NULL;
      END;
      $$ LANGUAGE plpgsql;
    `;
    await remoteClient.query(remoteSql);
    await remoteClient.end();

    // 2. Grant permissions on the local hub database
    const hubClient = new Client({ connectionString: hubUrl });
    await hubClient.connect();
    const hubSql = `
      CREATE SCHEMA IF NOT EXISTS "${rootSchema}";
      CREATE SCHEMA IF NOT EXISTS "${logSchema}";
      CREATE SCHEMA IF NOT EXISTS "${extSchema}";

      GRANT USAGE ON SCHEMA "${rootSchema}" TO fabric_user;
      GRANT USAGE ON SCHEMA "${logSchema}" TO fabric_user;
      GRANT USAGE ON SCHEMA "${extSchema}" TO fabric_user;

      ALTER DEFAULT PRIVILEGES IN SCHEMA "${rootSchema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${rootSchema}" GRANT USAGE, SELECT ON SEQUENCES TO fabric_user;

      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${rootSchema}" TO fabric_user;
      GRANT SELECT ON ALL TABLES IN SCHEMA "${rootSchema}" TO fabric_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${logSchema}" TO fabric_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${extSchema}" TO fabric_user;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${rootSchema}" TO fabric_user;
    `;
    await hubClient.query(hubSql);
    await hubClient.end();

    return { data: { ok: true } };
  }, { allowFail: true });

  // Seed demo rows directly via pg.Client so FK ordering is guaranteed
  await call('Seed demo rows (direct DB)', async () => {
    const remoteUrl = 'postgresql://remote_admin:remote_password@localhost:5436/remote_warehouse';
    const client = new Client({ connectionString: remoteUrl });
    await client.connect();
    const sc = `tenant_${TENANT_ID}_Global_Supply_Chain`;
    // Set search_path so tracking_seq resolves
    await client.query(`SET search_path TO "${sc}", public`);

    // multi-source inventory rows
    await client.query(`INSERT INTO "${sc}"."local_inventory" ("sku","stock") VALUES ('SKU-100',20),('SKU-200',40) ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO "${sc}"."remote_depot_mongo" ("item_id","qty") VALUES ('SKU-100',8),('SKU-300',19) ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO "${sc}"."active_products" ("sku") VALUES ('SKU-100'),('SKU-200') ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO "${sc}"."mongo_product_catalog" ("product_id") VALUES ('SKU-100'),('SKU-400') ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO "${sc}"."quarantined_items" ("sku") VALUES ('SKU-400') ON CONFLICT DO NOTHING`);

    // employees (self-referential hierarchy)
    await client.query(`
      INSERT INTO "${sc}"."employees" ("id","name","manager_id") VALUES
      ('00000000-0000-0000-0000-000000010001','CEO',NULL),
      ('00000000-0000-0000-0000-000000010002','Manager','00000000-0000-0000-0000-000000010001'),
      ('00000000-0000-0000-0000-000000010003','Engineer','00000000-0000-0000-0000-000000010002')
      ON CONFLICT (id) DO NOTHING
    `);

    // shipments FIRST (distinct regions to avoid GIST exclude_overlapping_shipments constraint),
    // then shipment_details (FK child after parent)
    await client.query(`
      INSERT INTO "${sc}"."shipments" ("id","region","status","total_amount") VALUES
      ('00000000-0000-0000-0000-000000020001','US','PENDING',100.00),
      ('00000000-0000-0000-0000-000000020002','EU','PENDING',250.00)
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(`
      INSERT INTO "${sc}"."shipment_details" ("id","shipment_id","notes") VALUES
      ('00000000-0000-0000-0000-000000030001','00000000-0000-0000-0000-000000020001','notes-1'),
      ('00000000-0000-0000-0000-000000030002','00000000-0000-0000-0000-000000020002','notes-2')
      ON CONFLICT (id) DO NOTHING
    `);

    await client.end();
    return { data: { ok: true } };
  }, { allowFail: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
