/**
 * Distributed Retail Analytics — external data seeder.
 *
 * Populates the THREE genuinely-separate external databases the data fabric
 * federates over (never the fabric's own control-plane DB):
 *
 *   Retail_Core       Postgres  :5436 / retail_core   customers, orders (+ view, matview)
 *   Product_Warehouse Postgres  :5436 / retail_wh      products, order_items
 *   Web_Analytics     MongoDB   :27017 / retail        web_events
 *
 * Referential integrity is kept ACROSS databases (order_items.order_id -> orders.id
 * in another DB; web_events.customer_id -> customers.id in another DB) so that
 * cross-source joins and aggregates return real matches.
 *
 * Run:  NODE_PATH=../../backend/node_modules node 01-seed-external-sources.js
 */
const { Client } = require('pg');
const { MongoClient } = require('mongodb');

const PG = { host: 'localhost', port: 5436, user: 'remote_admin', password: 'remote_password' };
const MONGO_URI = 'mongodb://admin:mongo_password@localhost:27017/?authSource=admin';

// Volumes (all >= 5000 per requirement).
const N_CUSTOMERS = 6000;
const N_ORDERS = 9000;
const N_PRODUCTS = 5000;
const N_ORDER_ITEMS = 18000;
const N_WEB_EVENTS = 12000;

const REGIONS = ['NA', 'EU', 'APAC', 'LATAM', 'MEA'];
const SEGMENTS = ['ENTERPRISE', 'SMB', 'CONSUMER', 'GOV'];
const STATUSES = ['PENDING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED'];
const CHANNELS = ['WEB', 'MOBILE', 'PARTNER', 'RETAIL'];
const CATEGORIES = ['ELECTRONICS', 'APPAREL', 'HOME', 'GROCERY', 'TOYS', 'SPORTS'];
// Weighted so the clickstream forms a realistic funnel (page_view >> checkout).
const EVENT_WEIGHTS = [['page_view', 55], ['search', 20], ['add_to_cart', 15], ['wishlist', 6], ['checkout', 4]];
const EVENT_BAG = EVENT_WEIGHTS.flatMap(([e, w]) => Array(w).fill(e));
const DEVICES = ['desktop', 'mobile', 'tablet'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const money = (lo, hi) => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
// A date within the last `days` days, as ISO.
const dateWithin = (days) => new Date(Date.now() - rnd(days) * 86400000 - rnd(86400) * 1000);

/** Insert `rows` (array of value-arrays) into table(cols) in chunks of `chunk`. */
async function bulkInsert(client, table, cols, rows, chunk = 1000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const tuples = slice.map((r) => {
      const ph = r.map((v) => { params.push(v); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

async function seedRetailCore() {
  const c = new Client({ ...PG, database: 'retail_core' });
  await c.connect();
  console.log('[Retail_Core] connected');
  await c.query(`DROP MATERIALIZED VIEW IF EXISTS mv_daily_region_sales CASCADE`);
  await c.query(`DROP VIEW IF EXISTS v_customer_orders CASCADE`);
  await c.query(`DROP TABLE IF EXISTS orders CASCADE`);
  await c.query(`DROP TABLE IF EXISTS customers CASCADE`);

  await c.query(`
    CREATE TABLE customers (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      region        TEXT NOT NULL,
      segment       TEXT NOT NULL,
      referred_by   INTEGER REFERENCES customers(id),
      signup_date   DATE NOT NULL,
      lifetime_value NUMERIC(12,2) NOT NULL
    )`);
  await c.query(`
    CREATE TABLE orders (
      id           INTEGER PRIMARY KEY,
      customer_id  INTEGER NOT NULL REFERENCES customers(id),
      order_date   TIMESTAMP NOT NULL,
      status       TEXT NOT NULL,
      channel      TEXT NOT NULL,
      total_amount NUMERIC(12,2) NOT NULL
    )`);

  // customers — referred_by always points to a smaller id (acyclic referral forest).
  const customers = [];
  for (let id = 1; id <= N_CUSTOMERS; id++) {
    const referredBy = id > 200 && Math.random() < 0.7 ? 1 + rnd(id - 1) : null;
    customers.push([id, `Customer_${id}`, pick(REGIONS), pick(SEGMENTS), referredBy,
      dateWithin(1400).toISOString().slice(0, 10), money(0, 50000)]);
  }
  await bulkInsert(c, 'customers', ['id', 'name', 'region', 'segment', 'referred_by', 'signup_date', 'lifetime_value'], customers);
  console.log(`[Retail_Core] customers = ${N_CUSTOMERS}`);

  // orders
  const orders = [];
  for (let id = 1; id <= N_ORDERS; id++) {
    orders.push([id, 1 + rnd(N_CUSTOMERS), dateWithin(365).toISOString(), pick(STATUSES), pick(CHANNELS), money(10, 5000)]);
  }
  await bulkInsert(c, 'orders', ['id', 'customer_id', 'order_date', 'status', 'channel', 'total_amount'], orders);
  console.log(`[Retail_Core] orders = ${N_ORDERS}`);

  await c.query(`CREATE INDEX ix_orders_customer ON orders(customer_id)`);
  await c.query(`CREATE INDEX ix_orders_date ON orders(order_date)`);

  await c.query(`
    CREATE VIEW v_customer_orders AS
      SELECT o.id AS order_id, o.customer_id, c.region, c.segment, o.status, o.total_amount, o.order_date
      FROM orders o JOIN customers c ON c.id = o.customer_id`);
  await c.query(`
    CREATE MATERIALIZED VIEW mv_daily_region_sales AS
      SELECT date_trunc('day', o.order_date)::date AS sales_day, c.region,
             count(*) AS order_count, sum(o.total_amount) AS revenue,
             round(avg(o.total_amount), 2) AS avg_order
      FROM orders o JOIN customers c ON c.id = o.customer_id
      GROUP BY 1, 2
      WITH DATA`);
  await c.query(`CREATE UNIQUE INDEX ux_mv_daily ON mv_daily_region_sales(sales_day, region)`);
  console.log('[Retail_Core] created v_customer_orders + mv_daily_region_sales (matview)');
  await c.end();
}

async function seedProductWarehouse() {
  const c = new Client({ ...PG, database: 'retail_wh' });
  await c.connect();
  console.log('[Product_Warehouse] connected');
  await c.query(`DROP TABLE IF EXISTS order_items CASCADE`);
  await c.query(`DROP TABLE IF EXISTS products CASCADE`);

  await c.query(`
    CREATE TABLE products (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL,
      category  TEXT NOT NULL,
      price     NUMERIC(10,2) NOT NULL,
      supplier  TEXT NOT NULL,
      in_stock  INTEGER NOT NULL
    )`);
  // order_items lives in a DIFFERENT database than orders/products it references —
  // no cross-DB FK is possible, which is exactly why the fabric must join them.
  await c.query(`
    CREATE TABLE order_items (
      id          INTEGER PRIMARY KEY,
      order_id    INTEGER NOT NULL,
      product_id  INTEGER NOT NULL,
      quantity    INTEGER NOT NULL,
      unit_price  NUMERIC(10,2) NOT NULL,
      line_amount NUMERIC(12,2) NOT NULL
    )`);

  const products = [];
  for (let id = 1; id <= N_PRODUCTS; id++) {
    products.push([id, `Product_${id}`, pick(CATEGORIES), money(1, 2000), `Supplier_${1 + rnd(200)}`, rnd(1000)]);
  }
  await bulkInsert(c, 'products', ['id', 'name', 'category', 'price', 'supplier', 'in_stock'], products);
  console.log(`[Product_Warehouse] products = ${N_PRODUCTS}`);

  const items = [];
  for (let id = 1; id <= N_ORDER_ITEMS; id++) {
    const qty = 1 + rnd(10);
    const unit = money(1, 2000);
    items.push([id, 1 + rnd(N_ORDERS), 1 + rnd(N_PRODUCTS), qty, unit, Math.round(qty * unit * 100) / 100]);
  }
  await bulkInsert(c, 'order_items', ['id', 'order_id', 'product_id', 'quantity', 'unit_price', 'line_amount'], items);
  console.log(`[Product_Warehouse] order_items = ${N_ORDER_ITEMS}`);
  await c.query(`CREATE INDEX ix_items_order ON order_items(order_id)`);
  await c.query(`CREATE INDEX ix_items_product ON order_items(product_id)`);
  await c.end();
}

async function seedWebAnalytics() {
  const mc = new MongoClient(MONGO_URI);
  await mc.connect();
  console.log('[Web_Analytics] connected');
  const db = mc.db('retail');
  await db.collection('web_events').drop().catch(() => {});
  const events = [];
  for (let i = 1; i <= N_WEB_EVENTS; i++) {
    const et = pick(EVENT_BAG);
    events.push({
      event_id: i,
      customer_id: 1 + rnd(N_CUSTOMERS),
      event_type: et,
      ts: dateWithin(365),
      url: `/p/${1 + rnd(N_PRODUCTS)}`,
      session_id: `sess_${1 + rnd(4000)}`,
      device: pick(DEVICES),
      revenue: et === 'checkout' ? money(20, 2000) : 0, // revenue only on checkout
    });
  }
  // insert in chunks
  for (let i = 0; i < events.length; i += 2000) {
    await db.collection('web_events').insertMany(events.slice(i, i + 2000));
  }
  await db.collection('web_events').createIndex({ customer_id: 1 });
  await db.collection('web_events').createIndex({ event_type: 1 });
  console.log(`[Web_Analytics] web_events = ${N_WEB_EVENTS}`);
  await mc.close();
}

(async () => {
  const t = Date.now();
  await seedRetailCore();
  await seedProductWarehouse();
  await seedWebAnalytics();
  console.log(`\nAll external sources seeded in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  console.log('Retail_Core(customers,orders) + Product_Warehouse(products,order_items) + Web_Analytics(web_events)');
})().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
