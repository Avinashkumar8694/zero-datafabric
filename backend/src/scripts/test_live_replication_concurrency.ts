/**
 * Exhaustive Live Test: Replication Under Active Concurrent Mutations & Multi-Source Parity
 * 
 * Verifies:
 * 1. Initial snapshot + concurrent DML (INSERT, UPDATE, DELETE) during/between cycles.
 * 2. Proves CDC captures tombstones and deletes them from destination (zero orphans).
 * 3. Proves INCREMENTAL leaves deleted orphans (verifying the architectural boundary).
 * 4. Heterogeneous engines tested live: PostgreSQL -> PostgreSQL and MySQL -> Elasticsearch.
 */
import { pool } from '../config/database';
process.env.ALLOW_HUB_SOURCE = 'true';
import { ReplicationService } from '../modules/replication/replication.service';
import { ConnectorFactory } from '../modules/metadata/connectors/factory';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Assertion {
  name: string;
  expected: any;
  actual: any;
  passed: boolean;
}

const assertions: Assertion[] = [];

function assert(name: string, actual: any, expected: any) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  assertions.push({ name, actual, expected, passed });
  if (passed) {
    console.log(`  \x1b[32m✔ PASS\x1b[0m ${name}`);
  } else {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m ${name} — Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
    throw new Error(`Assertion failed: ${name}`);
  }
}

async function run() {
  console.log('\n\x1b[1m\x1b[36m══════════════════════════════════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[36m  ZERO DATA FABRIC: CONCURRENT REPLICATION & CDC VERIFICATION SUITE   \x1b[0m');
  console.log('\x1b[1m\x1b[36m══════════════════════════════════════════════════════════════════════\x1b[0m\n');

  // Load registered data sources
  const dsRes = await pool.query('SELECT name, type, config FROM public.data_sources WHERE tenant_id=$1', ['tenant_A']);
  const sources: Record<string, any> = {};
  for (const r of dsRes.rows) sources[r.name] = r;

  console.log(`Discovered ${Object.keys(sources).length} registered sources in fabric catalog:`, Object.keys(sources).join(', '));

  // =========================================================================
  // SCENARIO 1: PostgreSQL -> PostgreSQL with CDC Under Active Concurrent Writes
  // =========================================================================
  console.log('\n\x1b[1m\x1b[35m▶ [SCENARIO 1] PostgreSQL -> PostgreSQL (CDC under Active Mutations)\x1b[0m');
  {
    const pgSrcConn: any = ConnectorFactory.getConnector(sources['Fabric_Hub_Postgres'].type, sources['Fabric_Hub_Postgres'].config);
    const pgDestConn: any = ConnectorFactory.getConnector(sources['External_Warehouse'].type, sources['External_Warehouse'].config);

    const srcSchema = 'public';
    const destSchema = 'public';
    const tableName = 'live_concurrent_orders';

    // 1. Setup Source Table
    console.log('  1. Initializing source table and seeding 20 baseline records...');
    await pgSrcConn.rawQuery(`DROP TABLE IF EXISTS ${srcSchema}.${tableName} CASCADE;`);
    await pgSrcConn.rawQuery(`
      CREATE TABLE ${srcSchema}.${tableName} (
        order_id INT PRIMARY KEY,
        customer_name VARCHAR(100),
        amount NUMERIC(10,2),
        status VARCHAR(50),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    for (let i = 1; i <= 20; i++) {
      await pgSrcConn.rawQuery(
        `INSERT INTO ${srcSchema}.${tableName} (order_id, customer_name, amount, status) VALUES ($1, $2, $3, $4)`,
        [i, `Customer_${i}`, i * 10.5, 'PENDING']
      );
    }

    // 2. Setup Replication Job with CDC
    await pool.query(`DELETE FROM fabric_system.replication_jobs WHERE name=$1`, ['live_pg_cdc_test']);
    const job = await ReplicationService.create({
      tenantId: 'tenant_A',
      name: 'live_pg_cdc_test',
      sourceName: 'Fabric_Hub_Postgres',
      destName: 'External_Warehouse',
      mode: 'ONE_WAY',
      strategy: 'CDC',
      destSchema,
      initialLoad: 'FULL',
    });

    console.log(`  2. Running Initial CDC Snapshot (Job ID: ${job.id})...`);
    const snapResult = await ReplicationService.run('tenant_A', job.id!, false, undefined, undefined, false);
    console.log(`     Snapshot completed: copied ${snapResult.tables[0]?.rows || 0} rows. Errors:`, snapResult.errors);

    // Verify snapshot arrived at destination
    const destRowsAfterSnap = await pgDestConn.rawQuery(`SELECT count(*)::int as count FROM ${destSchema}.${tableName}`);
    assert('Scenario 1 - Snapshot: Destination has exactly 20 initial rows', destRowsAfterSnap[0].count, 20);

    // 3. CONCURRENT PRODUCTION MUTATIONS
    // While replication is active in production, data changes:
    // - 5 Inserts (orders 21..25)
    // - 5 Updates (orders 1..5 change status to COMPLETED and amount + 100)
    // - 5 Hard Deletes (orders 11..15 are deleted from source)
    console.log('  3. Simulating concurrent production traffic on source database:');
    console.log('     -> Inserting 5 new orders (21..25)');
    for (let i = 21; i <= 25; i++) {
      await pgSrcConn.rawQuery(
        `INSERT INTO ${srcSchema}.${tableName} (order_id, customer_name, amount, status) VALUES ($1, $2, $3, $4)`,
        [i, `Customer_${i}`, i * 10.5, 'NEW']
      );
    }

    console.log('     -> Updating 5 existing orders (1..5) to status="COMPLETED"');
    for (let i = 1; i <= 5; i++) {
      await pgSrcConn.rawQuery(
        `UPDATE ${srcSchema}.${tableName} SET status='COMPLETED', amount = amount + 100, updated_at = NOW() WHERE order_id = $1`,
        [i]
      );
    }

    console.log('     -> Hard-deleting 5 orders (11..15) from source table');
    for (let i = 11; i <= 15; i++) {
      await pgSrcConn.rawQuery(`DELETE FROM ${srcSchema}.${tableName} WHERE order_id = $1`, [i]);
    }

    const srcCurrentRows = await pgSrcConn.rawQuery(`SELECT count(*)::int as count FROM ${srcSchema}.${tableName}`);
    assert('Scenario 1 - Source count after mutations is 20 (20 - 5 deletes + 5 inserts)', srcCurrentRows[0].count, 20);

    // 4. Trigger CDC Drain
    console.log('  4. Triggering CDC catchup cycle (draining outbox changes)...');
    const cdcResult = await ReplicationService.run('tenant_A', job.id!);
    console.log(`     CDC catchup cycle applied ${cdcResult.tables[0]?.rows || 0} change(s).`);

    // 5. Deep Parity Assertions
    console.log('  5. Verifying exact consistency and integrity on destination:');

    // 5a. Count matches
    const destRowsAfterCdc = await pgDestConn.rawQuery(`SELECT count(*)::int as count FROM ${destSchema}.${tableName}`);
    assert('Scenario 1 - Parity: Destination row count matches source count (20)', destRowsAfterCdc[0].count, 20);

    // 5b. Concurrent Inserts arrived
    const destInserts = await pgDestConn.rawQuery(`SELECT order_id, status FROM ${destSchema}.${tableName} WHERE order_id >= 21 ORDER BY order_id`);
    assert('Scenario 1 - Inserts: All 5 new concurrent orders (21..25) exist', destInserts.length, 5);

    // 5c. Concurrent Updates reconciled
    const destUpdates = await pgDestConn.rawQuery(`SELECT order_id, status FROM ${destSchema}.${tableName} WHERE order_id <= 5 ORDER BY order_id`);
    const allCompleted = destUpdates.every((r: any) => r.status === 'COMPLETED');
    assert('Scenario 1 - Updates: All 5 modified orders updated to COMPLETED', allCompleted, true);

    // 5d. Concurrent Deletes eradicated (ZERO ORPHANS)
    const destDeletes = await pgDestConn.rawQuery(`SELECT order_id FROM ${destSchema}.${tableName} WHERE order_id BETWEEN 11 AND 15`);
    assert('Scenario 1 - Deletes: Hard-deleted rows (11..15) completely removed from destination', destDeletes.length, 0);

    await pgSrcConn.close();
    await pgDestConn.close();
  }

  // =========================================================================
  // SCENARIO 2: MySQL Source -> Elasticsearch Target with CDC
  // =========================================================================
  console.log('\n\x1b[1m\x1b[35m▶ [SCENARIO 2] MySQL -> Elasticsearch (CDC under Active Mutations)\x1b[0m');
  {
    const mySrcConn: any = ConnectorFactory.getConnector(sources['Retail_MySQL'].type, sources['Retail_MySQL'].config);
    const esDestConn: any = ConnectorFactory.getConnector(sources['Elastic_Search'].type, sources['Elastic_Search'].config);

    const tableName = 'mysql_cdc_orders';
    const esIndex = 'retail_mysql_cdc_orders';

    // 1. Setup Source MySQL Table
    console.log('  1. Initializing MySQL table with 10 baseline records...');
    await mySrcConn.rawQuery(`DROP TABLE IF EXISTS \`${tableName}\`;`);
    await mySrcConn.rawQuery(`
      CREATE TABLE \`${tableName}\` (
        id INT PRIMARY KEY,
        item_name VARCHAR(100),
        qty INT,
        price DECIMAL(10,2),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    for (let i = 1; i <= 10; i++) {
      await mySrcConn.rawQuery(
        `INSERT INTO \`${tableName}\` (id, item_name, qty, price) VALUES (?, ?, ?, ?)`,
        [i, `Item_${i}`, i * 2, i * 15.0]
      );
    }

    // 2. Setup Replication Job MySQL -> ES
    await pool.query(`DELETE FROM fabric_system.replication_jobs WHERE name=$1`, ['live_mysql_es_cdc_test']);
    const job = await ReplicationService.create({
      tenantId: 'tenant_A',
      name: 'live_mysql_es_cdc_test',
      sourceName: 'Retail_MySQL',
      destName: 'Elastic_Search',
      mode: 'ONE_WAY',
      strategy: 'CDC',
      destSchema: 'retail',
      initialLoad: 'FULL',
    });

    console.log(`  2. Running Initial MySQL -> ES Snapshot...`);
    const snapResult = await ReplicationService.run('tenant_A', job.id!, false, undefined, undefined, false);
    console.log(`     Snapshot completed: copied ${snapResult.tables[0]?.rows || 0} docs to Elasticsearch.`);

    // Give ES a moment to refresh index
    await delay(1200);

    const esSearchSnapshot = await esDestConn.query('default', esIndex, { filter: {} });
    console.log(`     Elasticsearch initial docs found: ${esSearchSnapshot.length}`);
    assert('Scenario 2 - Snapshot: ES indexed initial documents', esSearchSnapshot.length >= 10, true);

    // 3. CONCURRENT MUTATIONS IN MYSQL
    console.log('  3. Simulating concurrent production traffic on MySQL source:');
    console.log('     -> Inserting 3 new items (11..13)');
    for (let i = 11; i <= 13; i++) {
      await mySrcConn.rawQuery(
        `INSERT INTO \`${tableName}\` (id, item_name, qty, price) VALUES (?, ?, ?, ?)`,
        [i, `Item_${i}`, 50, 99.99]
      );
    }

    console.log('     -> Updating item 1 qty to 999');
    await mySrcConn.rawQuery(`UPDATE \`${tableName}\` SET qty = 999 WHERE id = 1`);

    console.log('     -> Hard-deleting item 5 from MySQL');
    await mySrcConn.rawQuery(`DELETE FROM \`${tableName}\` WHERE id = 5`);

    // 4. Trigger CDC Catchup
    console.log('  4. Triggering CDC catchup to Elasticsearch...');
    const cdcResult = await ReplicationService.run('tenant_A', job.id!);
    console.log(`     CDC catchup applied ${cdcResult.tables[0]?.rows || 0} change(s).`);

    await delay(1200);

    // 5. Verify Parity in Elasticsearch
    const esSearchAfter = await esDestConn.query('default', esIndex, { filter: {} });
    console.log(`     Elasticsearch docs count after CDC: ${esSearchAfter.length}`);

    // Verify item 1 updated
    const item1 = esSearchAfter.find((d: any) => String(d.id || d._id) === '1');
    assert('Scenario 2 - Updates: Item 1 in ES reflects updated qty 999', item1?.qty, 999);

    // Verify item 5 deleted from ES
    const item5 = esSearchAfter.find((d: any) => String(d.id || d._id) === '5');
    assert('Scenario 2 - Deletes: Item 5 was physically deleted from Elasticsearch', item5, undefined);

    // Verify item 11 inserted
    const item11 = esSearchAfter.find((d: any) => String(d.id || d._id) === '11');
    assert('Scenario 2 - Inserts: New Item 11 exists in Elasticsearch', !!item11, true);

    await mySrcConn.close();
    await esDestConn.close();
  }

  // =========================================================================
  // SCENARIO 3: Direct Proof — INCREMENTAL vs CDC on Hard Deletes
  // =========================================================================
  console.log('\n\x1b[1m\x1b[35m▶ [SCENARIO 3] Direct Comparison: INCREMENTAL (Watermark) vs CDC on Hard Deletes\x1b[0m');
  {
    const pgConn: any = ConnectorFactory.getConnector(sources['Fabric_Hub_Postgres'].type, sources['Fabric_Hub_Postgres'].config);
    const destConn: any = ConnectorFactory.getConnector(sources['External_Warehouse'].type, sources['External_Warehouse'].config);

    const tableName = 'watermark_proof_orders';
    const schema = 'public';
    const destSchema = 'public';

    // Setup source with 5 rows
    await pgConn.rawQuery(`DROP TABLE IF EXISTS ${schema}.${tableName} CASCADE;`);
    await pgConn.rawQuery(`
      CREATE TABLE ${schema}.${tableName} (
        id INT PRIMARY KEY,
        title VARCHAR(50),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    for (let i = 1; i <= 5; i++) {
      await pgConn.rawQuery(`INSERT INTO ${schema}.${tableName} (id, title) VALUES ($1, $2)`, [i, `Doc_${i}`]);
    }

    // Create INCREMENTAL job
    await pool.query(`DELETE FROM fabric_system.replication_jobs WHERE name=$1`, ['incremental_proof_job']);
    const incJob = await ReplicationService.create({
      tenantId: 'tenant_A',
      name: 'incremental_proof_job',
      sourceName: 'Fabric_Hub_Postgres',
      destName: 'External_Warehouse',
      mode: 'ONE_WAY',
      strategy: 'INCREMENTAL',
      cdcColumn: 'updated_at',
      destSchema,
      initialLoad: 'FULL',
    });

    // 1. Initial snapshot
    console.log('  1. Running initial INCREMENTAL snapshot (copies 5 rows)...');
    await ReplicationService.run('tenant_A', incJob.id!);

    // 2. Perform hard delete on source: delete id = 3
    console.log('  2. Performing hard DELETE of id=3 on source table...');
    await pgConn.rawQuery(`DELETE FROM ${schema}.${tableName} WHERE id = 3;`);

    // Also insert id = 6 with advanced updated_at so it is strictly past the watermark
    await pgConn.rawQuery(`INSERT INTO ${schema}.${tableName} (id, title, updated_at) VALUES (6, 'Doc_6', NOW() + INTERVAL '5 seconds');`);

    // 3. Run INCREMENTAL refresh
    console.log('  3. Running INCREMENTAL refresh cycle...');
    await ReplicationService.run('tenant_A', incJob.id!);

    // 4. Check destination
    const destRows = await destConn.rawQuery(`SELECT id FROM ${destSchema}.${tableName} ORDER BY id;`);
    const destIds = destRows.map((r: any) => r.id);
    console.log(`     Destination IDs in INCREMENTAL mode: [${destIds.join(', ')}]`);

    // Proves that id=3 IS STILL PRESENT in destination under INCREMENTAL (orphan record!)
    const hasOrphan = destIds.includes(3);
    assert('Scenario 3 - INCREMENTAL Proof: Deleted id=3 still lingers as orphan in destination', hasOrphan, true);
    assert('Scenario 3 - INCREMENTAL Proof: New id=6 was captured', destIds.includes(6), true);
    console.log('     \x1b[33m⚡ Verification confirmed: INCREMENTAL cannot observe hard deletes, leading to orphans.\x1b[0m');
    console.log('     \x1b[32m✔ In contrast, CDC eliminated id=11..15 in Scenario 1 and item 5 in Scenario 2!\x1b[0m');

    await pgConn.close();
    await destConn.close();
  }

  // Summary
  console.log('\n\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════════════\x1b[0m');
  console.log(`\x1b[1m\x1b[32m  ALL REPLICATION & CONCURRENCY TESTS PASSED! (${assertions.length}/${assertions.length} assertions)\x1b[0m`);
  console.log('\x1b[1m\x1b[32m══════════════════════════════════════════════════════════════════════\x1b[0m\n');
}

run()
  .catch((err) => {
    console.error('\n\x1b[31mFatal test failure:\x1b[0m', err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
