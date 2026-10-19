/* eslint-disable no-console */
/**
 * Research Complex Queries Script
 * Runs complex queries in AST and SQL modes (single & multiple sources)
 */
const axios = require('axios');
const { BASE_URL, login, authHeaders } = require('./_client');

function printResult(title, res) {
  console.log(`\n--- ${title} ---`);
  if (!res) {
    console.log('Result is null (failed)');
    return;
  }
  const body = res.data || {};
  console.log('Status:', res.status);
  
  const rows = Array.isArray(body.data) ? body.data 
             : Array.isArray(body.results?.results) ? body.results.results
             : Array.isArray(body.results) ? body.results
             : [];
             
  console.log('Row count:', body.rowCount ?? rows.length);
  if (body.plan) {
    console.log('Strategy:', body.plan.strategy);
    console.log('Pushed Notes:', body.plan.pushed);
    console.log('Execution Ms:', body.plan.executionMs);
  }
  const displayRows = rows.slice(0, 3);
  console.log('Data (first 3 rows):', JSON.stringify(displayRows, null, 2));
}

async function run() {
  const token = await login();
  const headers = authHeaders(token);

  // ==========================================
  // SECTION 1: SINGLE-SOURCE COMPLEX QUERIES
  // ==========================================

  // A. SQL Mode: Window Function
  try {
    const res = await axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
        SELECT sku, stock,
               ROW_NUMBER() OVER (ORDER BY stock DESC) as rank,
               AVG(stock) OVER () as avg_stock
        FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory"
        LIMIT 5
      `
    }, { headers });
    printResult('1A. Single-Source SQL: Window Function (Hub)', res);
  } catch (err) {
    console.error('1A failed:', err.response ? err.response.data : err.message);
  }

  // B. SQL Mode: Aggregate with HAVING
  try {
    const res = await axios.post(`${BASE_URL}/queries/exec`, {
      sql: `
        SELECT sku, SUM(stock) as total_stock
        FROM "tenant_tenant_A_Global_Supply_Chain"."local_inventory"
        GROUP BY sku
        HAVING SUM(stock) > 100
        LIMIT 5
      `
    }, { headers });
    printResult('1B. Single-Source SQL: Aggregate with HAVING (Hub)', res);
  } catch (err) {
    console.error('1B failed:', err.response ? err.response.data : err.message);
  }

  // C. AST Mode: Window Function (Capability Compensation)
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 5,
        query: {
          select: [
            'sku',
            'stock',
            { window: 'ROW_NUMBER', orderBy: [{ column: 'stock', direction: 'DESC' }], alias: 'rank' }
          ],
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' }
        }
      }
    }, { headers });
    printResult('1C. Single-Source AST: Window Function (Hub)', res);
  } catch (err) {
    console.error('1C failed:', err.response ? err.response.data : err.message);
  }

  // D. AST Mode: Aggregate with HAVING
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 5,
        query: {
          select: ['sku', { aggregate: 'SUM', column: 'stock', alias: 'total_stock' }],
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' },
          groupBy: ['sku'],
          having: [{ column: 'total_stock', operator: 'GT', value: 100 }]
        }
      }
    }, { headers });
    printResult('1D. Single-Source AST: Aggregate with HAVING (Hub)', res);
  } catch (err) {
    console.error('1D failed:', err.response ? err.response.data : err.message);
  }

  // ==========================================
  // SECTION 2: MULTI-SOURCE COMPLEX QUERIES
  // ==========================================

  // E. AST Mode: Cross-Engine JOIN with Filter, Order, and Limit
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 5,
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' }
          }],
          where: [{ column: 'inv.stock', operator: 'GT', value: 10 }],
          orderBy: [{ column: 'inv.stock', direction: 'DESC' }]
        }
      }
    }, { headers });
    printResult('2E. Multi-Source AST: Cross-Engine JOIN with Predicate & Ordering', res);
  } catch (err) {
    console.error('2E failed:', err.response ? err.response.data : err.message);
  }

  // F. AST Mode: Cross-Engine JOIN + Aggregate
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 5,
        query: {
          from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres', alias: 'inv' },
          joins: [{
            type: 'INNER',
            resource: 'remote_depot_mongo',
            source: 'Activity_Mongo',
            alias: 'depot',
            on: { left: 'inv.sku', operator: 'EQ', right: 'depot.item_id' }
          }],
          groupBy: ['inv.sku'],
          select: ['inv.sku', { aggregate: 'SUM', column: 'depot.qty', alias: 'total_depot_qty' }]
        }
      }
    }, { headers });
    printResult('2F. Multi-Source AST: Cross-Engine JOIN + Aggregate Group By', res);
  } catch (err) {
    console.error('2F failed:', err.response ? err.response.data : err.message);
  }

  // G. AST Mode: Cross-Engine UNION + Aggregate
  try {
    const res = await axios.post(`${BASE_URL}/analytics/query`, {
      queryConfig: {
        type: 'SELECT',
        schema: 'Global_Supply_Chain',
        limit: 5,
        query: {
          select: [{ aggregate: 'AVG', column: 'stock', alias: 'avg_all_stock' }],
          union: [
            { select: [{ column: 'stock', alias: 'stock' }], from: { resource: 'local_inventory', source: 'Fabric_Hub_Postgres' } },
            { select: [{ column: 'qty', alias: 'stock' }], from: { resource: 'remote_depot_mongo', source: 'Activity_Mongo' } }
          ]
        }
      }
    }, { headers });
    printResult('2G. Multi-Source AST: Cross-Engine UNION + AVG Aggregate', res);
  } catch (err) {
    console.error('2G failed:', err.response ? err.response.data : err.message);
  }
}

run();
