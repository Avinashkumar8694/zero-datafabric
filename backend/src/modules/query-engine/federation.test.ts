jest.mock('../../config/database', () => ({
  pool: { query: jest.fn() },
  queryWithContext: jest.fn(),
}));
jest.mock('../metadata/connectors/factory', () => ({
  ConnectorFactory: { getConnector: jest.fn() },
}));

import { FederationExecutor } from './federation';
import { queryWithContext } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';

const qwc = queryWithContext as jest.Mock;
const getConnector = ConnectorFactory.getConnector as jest.Mock;

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
  const connector = { query: jest.fn().mockResolvedValue(rows), close: jest.fn().mockResolvedValue(undefined) };
  getConnector.mockReturnValue(connector);
  return connector;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FABRIC_FED_MAX_ROWS_PER_LEG;
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
});
