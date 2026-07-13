jest.mock('../../config/database', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
  queryWithContext: jest.fn(),
}));
jest.mock('../metadata/connectors/factory', () => ({
  ConnectorFactory: { getConnector: jest.fn() },
}));

import { FederationExecutor } from './federation';
import { pool, queryWithContext } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';

const qwc = queryWithContext as jest.Mock;
const getConnector = ConnectorFactory.getConnector as jest.Mock;

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const localLeg = (resource: string) => ({
  source: 'Fabric_Hub_Postgres', resource, engine: 'POSTGRES', syncType: 'VIRTUAL',
  reachableInPg: true, physicalSchema: null, physicalTable: resource, config: {},
});
const connectorLeg = (source: string, resource: string) => ({
  source, resource, engine: 'MONGODB', syncType: 'VIRTUAL',
  reachableInPg: false, physicalSchema: 'db', physicalTable: resource, config: {},
});

function planFrom(...legs: any[]) {
  const resolveMap: any = {};
  for (const l of legs) resolveMap[`${l.source}::${l.resource}`] = l;
  return { strategy: 'CROSS_ENGINE', legs, resolveMap, pushed: [], warnings: [] } as any;
}

function mockConnectorReturning(rows: any[]) {
  const connector = {
    query: jest.fn().mockResolvedValue(rows),
    queryStream: jest.fn().mockImplementation(async function* () {
      for (const r of rows) yield r;
    }),
    close: jest.fn().mockResolvedValue(undefined)
  };
  getConnector.mockReturnValue(connector);
  return connector;
}

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).mockClientRows = [];
  (pool.connect as jest.Mock).mockImplementation(() => Promise.resolve(mockClient));
  (mockClient.query as jest.Mock).mockImplementation((arg1) => {
    const rows = (global as any).mockClientRows || [];
    if (typeof arg1 === 'string') {
      if (arg1.includes('information_schema.schemata')) {
        return Promise.resolve({ rows: [{ schema_name: 'tenant_tenant_x' }] });
      }
      return Promise.resolve({ rows });
    }
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const r of rows) yield r;
      },
      destroy: jest.fn(),
    };
  });
  delete process.env.FABRIC_FED_MAX_ROWS_PER_LEG;
  delete process.env.FABRIC_FED_COST_PROBE;
  delete process.env.FABRIC_FED_BROADCAST_MAX;
  delete process.env.FABRIC_FED_MAX_BIND_BATCHES;
  delete process.env.FABRIC_FED_BIND_MAX_KEYS;
});

describe('FederationExecutor', () => {
  it('UNION combines legs from different engines with distinct semantics', async () => {
    const ast = {
      union: [
        { from: { source: 'Fabric_Hub_Postgres', resource: 'local_inv' }, select: ['sku'] },
        { from: { source: 'Mongo_Src', resource: 'remote_inv' }, select: ['sku'] },
      ],
      limit: 100,
    };
    (global as any).mockClientRows = [{ sku: 'A' }, { sku: 'B' }];
    qwc.mockResolvedValue({ rows: [{ sku: 'A' }, { sku: 'B' }] });
    mockConnectorReturning([{ sku: 'B' }, { sku: 'C' }]);

    const plan = planFrom(localLeg('local_inv'), connectorLeg('Mongo_Src', 'remote_inv'));
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    expect(res.data).toEqual([{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]); // B deduped
    expect(res.warnings).toHaveLength(0);
  });

  it('warns (does not silently truncate) when a leg hits the row cap', async () => {
    process.env.FABRIC_FED_MAX_ROWS_PER_LEG = '2';
    const ast = {
      union: [
        { from: { source: 'Fabric_Hub_Postgres', resource: 'a' }, select: ['x'] },
        { from: { source: 'Mongo_Src', resource: 'b' }, select: ['x'] },
      ],
      limit: 100,
    };
    (global as any).mockClientRows = [{ x: 1 }];
    qwc.mockResolvedValue({ rows: [{ x: 1 }] });
    mockConnectorReturning([{ x: 2 }, { x: 3 }]); // exactly the cap

    const plan = planFrom(localLeg('a'), connectorLeg('Mongo_Src', 'b'));
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    expect(res.warnings.some((w) => w.includes('Mongo_Src.b') && w.includes('cap'))).toBe(true);
  });

  it('performs a cross-engine INNER hash join with alias-qualified output', async () => {
    const ast = {
      from: { source: 'Fabric_Hub_Postgres', resource: 'customers', alias: 'c' },
      joins: [{
        type: 'INNER', source: 'Mongo_Src', resource: 'orders', alias: 'o',
        on: { left: 'c.id', operator: 'EQ', right: 'o.cust_id' },
      }],
      where: [],
      limit: 100,
    };
    qwc.mockResolvedValue({ rows: [{ id: 1, name: 'x' }, { id: 2, name: 'y' }] });
    mockConnectorReturning([{ cust_id: 1, total: 10 }, { cust_id: 1, total: 20 }]);

    const plan = planFrom(localLeg('customers'), connectorLeg('Mongo_Src', 'orders'));
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    expect(res.data).toEqual([
      { 'c.id': 1, 'c.name': 'x', 'o.cust_id': 1, 'o.total': 10 },
      { 'c.id': 1, 'c.name': 'x', 'o.cust_id': 1, 'o.total': 20 },
    ]);
  });

  it('LEFT join preserves unmatched left rows (qualified)', async () => {
    const ast = {
      from: { source: 'Fabric_Hub_Postgres', resource: 'customers', alias: 'c' },
      joins: [{
        type: 'LEFT', source: 'Mongo_Src', resource: 'orders', alias: 'o',
        on: { left: 'c.id', operator: 'EQ', right: 'o.cust_id' },
      }],
      limit: 100,
    };
    qwc.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
    mockConnectorReturning([{ cust_id: 1, total: 10 }]);

    const plan = planFrom(localLeg('customers'), connectorLeg('Mongo_Src', 'orders'));
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    expect(res.data).toEqual([{ 'c.id': 1, 'o.cust_id': 1, 'o.total': 10 }, { 'c.id': 2 }]);
  });

  // The headline scenario: find one customer by id across two sources WITHOUT fetching all.
  it('pushes the filter to the driving side and bind-joins the key to the other source', async () => {
    process.env.FABRIC_FED_COST_PROBE = '0'; // isolate the bind path (no probe/broadcast)
    const ast = {
      from: { source: 'Postgres_DS1', resource: 'customer', alias: 'c1' },
      joins: [{
        type: 'INNER', source: 'Mongo_DS2', resource: 'customer', alias: 'c2',
        on: { left: 'c1.id', operator: 'EQ', right: 'c2.id' },
      }],
      where: [{ column: 'c1.id', operator: 'EQ', value: 5 }],
      limit: 100,
    };

    // DS1 (VIRTUAL Postgres) via connector — should be asked for id = 5 only.
    const ds1 = { query: jest.fn().mockResolvedValue([{ id: 5, name: 'Ada' }]), close: jest.fn() };
    // DS2 (Mongo) via connector — should be asked for id IN [5] only.
    const ds2 = { query: jest.fn().mockResolvedValue([{ id: 5, tier: 'GOLD' }]), close: jest.fn() };
    getConnector.mockImplementation((engine: string) => (engine === 'MONGODB' ? ds2 : ds1));

    const plan = planFrom(
      { source: 'Postgres_DS1', resource: 'customer', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: true, physicalSchema: 'public', physicalTable: 'customer', config: { host: 'h1' } },
      { source: 'Mongo_DS2', resource: 'customer', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'customer', config: { host: 'h2' } },
    );
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // Driving side (DS1) was filtered to id = 5 (predicate pushdown), NOT a full scan.
    expect(ds1.query).toHaveBeenCalledWith('public', 'customer', expect.objectContaining({
      filter: expect.objectContaining({ id: { $eq: 5 } }),
    }));
    // Other side (DS2) received a bind-join IN(...) on the key — only matching rows.
    expect(ds2.query).toHaveBeenCalledWith('db', 'customer', expect.objectContaining({
      filter: expect.objectContaining({ id: expect.objectContaining({ $in: [5] }) }),
    }));
    expect(res.data).toEqual([{ 'c1.id': 5, 'c1.name': 'Ada', 'c2.id': 5, 'c2.tier': 'GOLD' }]);
    expect(res.pushed.some((p) => p.includes('bind-join'))).toBe(true);
  });

  it('multi-source aggregate: pushes partial GROUP BY to each source and merges (no full fetch)', async () => {
    // SUM(amount) GROUP BY region across a Postgres source and a Mongo source.
    const legA = { from: { source: 'Fabric_Hub_Postgres', resource: 'orders' }, select: ['region', { aggregate: 'SUM', column: 'amount', alias: 'total' }, { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['region'] };
    const legB = { from: { source: 'Mongo_Src', resource: 'orders' }, select: ['region', { aggregate: 'SUM', column: 'amount', alias: 'total' }, { aggregate: 'COUNT', column: '*', alias: 'n' }], groupBy: ['region'] };
    const ast = { union: [legA, legB], limit: 100 };

    // Each source returns PARTIAL group rows, not raw rows.
    qwc.mockResolvedValue({ rows: [{ region: 'EU', total: 30, n: 2 }] });
    const mongo = { query: jest.fn().mockResolvedValue([{ region: 'EU', total: 70, n: 3 }, { region: 'US', total: 5, n: 1 }]), close: jest.fn() };
    getConnector.mockReturnValue(mongo);

    const plan = planFrom(localLeg('orders'), connectorLeg('Mongo_Src', 'orders'));
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // The Postgres leg was asked for a GROUP BY partial (aggregates present in canonical).
    const pgCall = qwc.mock.calls[0][0] as string;
    expect(pgCall).toContain('GROUP BY');
    // The Mongo leg received an aggregate spec (pipeline), not a full find.
    expect(mongo.query.mock.calls[0][2]).toEqual(expect.objectContaining({ aggregates: expect.any(Array), groupBy: ['region'] }));
    // Partials merged: EU total 30+70=100, n 2+3=5; US total 5, n 1.
    const byRegion = Object.fromEntries(res.data.map((r) => [r.region, r]));
    expect(byRegion.EU).toEqual({ region: 'EU', total: 100, n: 5 });
    expect(byRegion.US).toEqual({ region: 'US', total: 5, n: 1 });
    expect(res.pushed.some((p) => p.includes('partial aggregate'))).toBe(true);
  });

  it('transitively propagates a constant to BOTH sides across the join key', async () => {
    // Filter is written on c2, but must also reach c1 through c1.id = c2.id.
    const ast = {
      from: { source: 'Postgres_DS1', resource: 'customer', alias: 'c1' },
      joins: [{
        type: 'INNER', source: 'Mongo_DS2', resource: 'customer', alias: 'c2',
        on: { left: 'c1.id', operator: 'EQ', right: 'c2.id' },
      }],
      where: [{ column: 'c2.id', operator: 'EQ', value: 9 }],
      limit: 100,
    };
    const ds1 = { query: jest.fn().mockResolvedValue([{ id: 9 }]), close: jest.fn() };
    const ds2 = { query: jest.fn().mockResolvedValue([{ id: 9 }]), close: jest.fn() };
    getConnector.mockImplementation((engine: string) => (engine === 'MONGODB' ? ds2 : ds1));

    const plan = planFrom(
      { source: 'Postgres_DS1', resource: 'customer', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: true, physicalSchema: 'public', physicalTable: 'customer', config: { host: 'h1' } },
      { source: 'Mongo_DS2', resource: 'customer', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'customer', config: { host: 'h2' } },
    );
    await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // The driving side c1 got id = 9 even though the literal was written on c2.
    expect(ds1.query).toHaveBeenCalledWith('public', 'customer', expect.objectContaining({
      filter: expect.objectContaining({ id: { $eq: 9 } }),
    }));
  });

  it('cost-based driving side: drives from the smaller leg (live cardinality probe)', async () => {
    // FROM is a HUGE table (100000 rows, above the broadcast ceiling); the joined leg
    // is SMALL (2 rows). Default drives from FROM → binds 100000 keys to the small side.
    // The cost probe should flip it: small drives, and the BIND lands on the big side.
    process.env.FABRIC_FED_BROADCAST_MAX = '10'; // keep the big side out of the broadcast path
    const ast = {
      from: { source: 'PG_Big', resource: 'big', alias: 'a' },
      joins: [{ type: 'INNER', source: 'Mongo_Small', resource: 'small', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
      select: ['a.id', 'b.tag'],
      where: [{ column: 'a.id', operator: 'GT', value: 0 }],
      limit: 100,
    };
    // Each connector returns a COUNT row when aggregates are requested (the probe), else data rows.
    const bigConn = { query: jest.fn((_s: string, _t: string, cfg: any) => Promise.resolve(cfg.aggregates ? [{ __cnt: 100000 }] : [{ id: 2, name: 'x' }])), close: jest.fn().mockResolvedValue(undefined) };
    const smallConn = { query: jest.fn((_s: string, _t: string, cfg: any) => Promise.resolve(cfg.aggregates ? [{ __cnt: 2 }] : [{ id: 2, tag: 't' }])), close: jest.fn().mockResolvedValue(undefined) };
    getConnector.mockImplementation((engine: string) => (engine === 'MONGODB' ? smallConn : bigConn));

    const plan = planFrom(
      { source: 'PG_Big', resource: 'big', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'public', physicalTable: 'big', config: { host: 'h1' } },
      { source: 'Mongo_Small', resource: 'small', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'small', config: { host: 'h2' } },
    );
    await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // The BIND ($in) landed on the BIG side — only possible if the small side won the
    // driving-side selection and the join flipped to bind against `big`.
    expect(bigConn.query).toHaveBeenCalledWith('public', 'big', expect.objectContaining({
      filter: expect.objectContaining({ id: expect.objectContaining({ $in: [2] }) }),
    }));
  });

  it('broadcast hash join: both sides small → fetched in parallel, neither bound', async () => {
    const ast = {
      from: { source: 'PG_A', resource: 'a', alias: 'a' },
      joins: [{ type: 'INNER', source: 'Mongo_B', resource: 'b', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
      select: ['a.id', 'b.tag'],
      where: [{ column: 'a.id', operator: 'GT', value: 0 }],
      limit: 100,
    };
    const connA = { query: jest.fn((_s: string, _t: string, cfg: any) => Promise.resolve(cfg.aggregates ? [{ __cnt: 4 }] : [{ id: 2 }, { id: 4 }])), close: jest.fn().mockResolvedValue(undefined) };
    const connB = { query: jest.fn((_s: string, _t: string, cfg: any) => Promise.resolve(cfg.aggregates ? [{ __cnt: 3 }] : [{ id: 2, tag: 'x' }])), close: jest.fn().mockResolvedValue(undefined) };
    getConnector.mockImplementation((engine: string) => (engine === 'MONGODB' ? connB : connA));

    const plan = planFrom(
      { source: 'PG_A', resource: 'a', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'public', physicalTable: 'a', config: { host: 'h1' } },
      { source: 'Mongo_B', resource: 'b', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'b', config: { host: 'h2' } },
    );
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // Neither side received a bind $in — both were fetched with their own predicate only.
    const dataCall = (m: jest.Mock) => m.mock.calls.find((c) => !c[2]?.aggregates)?.[2];
    expect(dataCall(connA.query).filter).not.toHaveProperty('id.$in');
    expect(dataCall(connB.query).filter).not.toHaveProperty('id.$in');
    expect(res.data).toEqual([{ 'a.id': 2, 'b.tag': 'x' }]); // hash join on id=2
  });

  it('batched bind: a large key set is chunked into IN(...) batches, not a full scan', async () => {
    process.env.FABRIC_FED_COST_PROBE = '0';      // FROM drives
    process.env.FABRIC_FED_BIND_MAX_KEYS = '2';   // force chunking
    const ast = {
      from: { source: 'PG_Drv', resource: 'drv', alias: 'd' },
      joins: [{ type: 'INNER', source: 'Mongo_P', resource: 'p', alias: 'p', on: { left: 'd.id', operator: 'EQ', right: 'p.id' } }],
      select: ['d.id', 'p.tag'],
      where: [{ column: 'd.id', operator: 'GT', value: 0 }],
      limit: 100,
    };
    // Driving side returns 5 distinct keys → with bindMax=2 → 3 batches.
    const drv = { query: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]), close: jest.fn() };
    const probe = { query: jest.fn((_s: string, _t: string, cfg: any) => Promise.resolve((cfg.filter?.id?.$in || []).map((id: number) => ({ id, tag: 't' + id })))), close: jest.fn() };
    getConnector.mockImplementation((engine: string) => (engine === 'MONGODB' ? probe : drv));

    const plan = planFrom(
      { source: 'PG_Drv', resource: 'drv', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'public', physicalTable: 'drv', config: { host: 'h1' } },
      { source: 'Mongo_P', resource: 'p', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'p', config: { host: 'h2' } },
    );
    const res = await FederationExecutor.execute('tenant_x', ast, plan, 'tenant_tenant_x');

    // 5 keys / bindMax 2 → 3 batched probe fetches (each an IN(...)), and all 5 rows joined.
    expect(probe.query).toHaveBeenCalledTimes(3);
    for (const c of probe.query.mock.calls) expect(c[2].filter.id).toHaveProperty('$in');
    expect(res.data).toHaveLength(5);
  });

  it('DISTINCT dedupes a cross-engine join projection', async () => {
    process.env.FABRIC_FED_COST_PROBE = '0';
    const ast = {
      from: { source: 'PG', resource: 'r', alias: 'a' },
      joins: [{ type: 'INNER', source: 'MG', resource: 'd', alias: 'd', on: { left: 'a.id', operator: 'EQ', right: 'd.id' } }],
      select: ['d.grade'], distinct: true, where: [{ column: 'a.id', operator: 'GT', value: 0 }], limit: 20,
    };
    const pg = { query: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]), close: jest.fn() };
    const mg = { query: jest.fn().mockResolvedValue([{ id: 1, grade: 'gold' }, { id: 2, grade: 'gold' }]), close: jest.fn() };
    getConnector.mockImplementation((e: string) => (e === 'MONGODB' ? mg : pg));
    const plan = planFrom(
      { source: 'PG', resource: 'r', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'public', physicalTable: 'r', config: { host: 'h1' } },
      { source: 'MG', resource: 'd', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'd', config: { host: 'h2' } },
    );
    const res = await FederationExecutor.execute('t', ast, plan, 'tenant_t');
    expect(res.data).toEqual([{ 'd.grade': 'gold' }]); // 2 joined rows, both gold → 1 distinct
  });

  it('applies OFFSET+LIMIT on an in-fabric grouped cross-engine result', async () => {
    process.env.FABRIC_FED_COST_PROBE = '0';
    const ast = {
      from: { source: 'PG', resource: 'r', alias: 'a' },
      joins: [{ type: 'INNER', source: 'MG', resource: 'd', alias: 'd', on: { left: 'a.id', operator: 'EQ', right: 'd.id' } }],
      select: ['d.grade', { aggregate: 'COUNT', column: '*', alias: 'n' }],
      where: [{ column: 'a.id', operator: 'GT', value: 0 }], groupBy: ['d.grade'],
      orderBy: [{ column: 'd.grade', direction: 'ASC' }], limit: 1, offset: 1,
    };
    const pg = { query: jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]), close: jest.fn() };
    const mg = { query: jest.fn().mockResolvedValue([{ id: 1, grade: 'a' }, { id: 2, grade: 'b' }, { id: 3, grade: 'c' }]), close: jest.fn() };
    getConnector.mockImplementation((e: string) => (e === 'MONGODB' ? mg : pg));
    const plan = planFrom(
      { source: 'PG', resource: 'r', engine: 'POSTGRES', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'public', physicalTable: 'r', config: { host: 'h1' } },
      { source: 'MG', resource: 'd', engine: 'MONGODB', syncType: 'VIRTUAL', reachableInPg: false, physicalSchema: 'db', physicalTable: 'd', config: { host: 'h2' } },
    );
    const res = await FederationExecutor.execute('t', ast, plan, 'tenant_t');
    expect(res.data.length).toBe(1);           // groups a,b,c → offset 1, limit 1
    expect(res.data[0]['d.grade']).toBe('b');  // the 2nd group after ORDER BY grade ASC
  });

  describe('joinLegProjections (projection pushdown)', () => {
    const proj = (ast: any, legMetas: any[]) => (FederationExecutor as any).joinLegProjections(ast, legMetas);
    const metas = [
      { alias: 'a', source: 'S1', resource: 't1', joinType: null, on: null },
      { alias: 'b', source: 'S2', resource: 't2', joinType: 'INNER', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } },
    ];

    it('fetches only selected columns + join keys per leg', () => {
      const ast = {
        from: { source: 'S1', resource: 't1', alias: 'a' },
        joins: [{ type: 'INNER', source: 'S2', resource: 't2', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
        select: ['a.name', 'b.type'],
        where: [{ column: 'a.status', operator: 'EQ', value: 'X' }],
      };
      const p = proj(ast, metas);
      expect(new Set(p.a)).toEqual(new Set(['name', 'id', 'status'])); // selected + join key + predicate
      expect(new Set(p.b)).toEqual(new Set(['type', 'id']));           // selected + join key
    });

    it('always includes join keys even when not selected', () => {
      const ast = {
        from: { source: 'S1', resource: 't1', alias: 'a' },
        joins: [{ type: 'INNER', source: 'S2', resource: 't2', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
        select: ['a.name'],
      };
      const p = proj(ast, metas);
      expect(p.a).toContain('id');
      expect(p.b).toContain('id'); // needed for the in-fabric hash/bind join though b projects nothing
    });

    it('bails to * (null) on an unqualified column in a multi-table join', () => {
      const ast = {
        from: { source: 'S1', resource: 't1', alias: 'a' },
        joins: [{ type: 'INNER', source: 'S2', resource: 't2', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
        select: ['name'], // ambiguous — could be a.name or b.name
      };
      expect(proj(ast, metas)).toBeNull();
    });

    it('bails to * on a raw expression / star select', () => {
      const base = { from: { source: 'S1', resource: 't1', alias: 'a' }, joins: [{ type: 'INNER', source: 'S2', resource: 't2', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }] };
      expect(proj({ ...base, select: [{ expression: 'a.x + b.y', alias: 'z' }] }, metas)).toBeNull();
      expect(proj({ ...base, select: ['*'] }, metas)).toBeNull();
      expect(proj({ ...base, select: [] }, metas)).toBeNull(); // implicit *
    });

    it('handles alias.* and COUNT(*) without dropping data', () => {
      const ast = {
        from: { source: 'S1', resource: 't1', alias: 'a' },
        joins: [{ type: 'INNER', source: 'S2', resource: 't2', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
        select: ['a.*', { aggregate: 'COUNT', column: '*', alias: 'n' }],
      };
      const p = proj(ast, metas);
      expect(p.a).toBeNull();           // a.* → fetch all columns of a
      expect(p.b).toContain('id');      // b still needs its join key
    });
  });
});
