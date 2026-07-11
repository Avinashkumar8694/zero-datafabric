import { parseAggregates, partialSpec, mergePartials, aggregateRaw } from './aggregate';
import { PushdownCompiler } from './pushdown';

describe('aggregate parsing', () => {
  it('parses object aggregate specs + group columns', () => {
    const plan = parseAggregates(
      ['region', { aggregate: 'SUM', column: 'amount', alias: 'total' }, { aggregate: 'COUNT', column: '*', alias: 'n' }],
      ['region']
    );
    expect(plan).not.toBeNull();
    expect(plan!.groupCols).toEqual(['region']);
    expect(plan!.aggregates).toEqual([
      { func: 'SUM', column: 'amount', alias: 'total' },
      { func: 'COUNT', column: null, alias: 'n' },
    ]);
  });

  it('parses string aggregate specs like count(*) and avg(price)', () => {
    const plan = parseAggregates(['status', 'count(*)', 'AVG(price) as p'], undefined);
    expect(plan!.groupCols).toEqual(['status']);
    expect(plan!.aggregates.map((a) => a.func)).toEqual(['COUNT', 'AVG']);
    expect(plan!.aggregates[1].alias).toBe('p');
  });

  it('returns null for a non-aggregate select', () => {
    expect(parseAggregates(['id', 'name'], undefined)).toBeNull();
  });
});

describe('partial-aggregate decomposition', () => {
  it('expands AVG into hidden SUM + COUNT partials', () => {
    const plan = parseAggregates(['g', { aggregate: 'AVG', column: 'x', alias: 'avg_x' }], ['g'])!;
    const partial = partialSpec(plan);
    expect(partial.aggregates.map((a) => `${a.func}:${a.alias}`)).toEqual(['SUM:__sum__avg_x', 'COUNT:__cnt__avg_x']);
  });
});

describe('mergePartials (fan aggregate across sources)', () => {
  it('sums COUNT/SUM, mins/maxes, and recomputes AVG from partials', () => {
    const plan = parseAggregates(
      ['region', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'SUM', column: 'amt', alias: 's' }, { aggregate: 'AVG', column: 'amt', alias: 'a' }],
      ['region']
    )!;
    // Two sources each already grouped by region (partial rows). AVG carried as sum+count.
    const partials = [
      { region: 'EU', n: 2, s: 30, __sum__a: 30, __cnt__a: 2 },
      { region: 'EU', n: 3, s: 70, __sum__a: 70, __cnt__a: 3 },
      { region: 'US', n: 1, s: 10, __sum__a: 10, __cnt__a: 1 },
    ];
    const merged = mergePartials(partials, plan).sort((x, y) => (x.region < y.region ? -1 : 1));
    expect(merged).toEqual([
      { region: 'EU', n: 5, s: 100, a: 20 }, // (30+70)/(2+3)=20
      { region: 'US', n: 1, s: 10, a: 10 },
    ]);
  });
});

describe('aggregateRaw (post-join, raw rows, alias-qualified keys tolerated)', () => {
  it('groups raw joined rows and computes finals', () => {
    const plan = parseAggregates(
      ['region', { aggregate: 'COUNT', column: '*', alias: 'n' }, { aggregate: 'AVG', column: 'amount', alias: 'avg_amt' }, { aggregate: 'COUNT', column: 'cust', alias: 'dc', distinct: true } as any],
      ['region']
    )!;
    const rows = [
      { 'c.region': 'EU', 'o.amount': 10, 'o.cust': 1 },
      { 'c.region': 'EU', 'o.amount': 30, 'o.cust': 2 },
      { 'c.region': 'US', 'o.amount': 5, 'o.cust': 1 },
    ];
    const out = aggregateRaw(rows, plan).sort((x, y) => (x.region < y.region ? -1 : 1));
    expect(out[0]).toEqual({ region: 'EU', n: 2, avg_amt: 20, dc: 2 });
    expect(out[1]).toEqual({ region: 'US', n: 1, avg_amt: 5, dc: 1 });
  });
});

describe('PushdownCompiler aggregate emission', () => {
  it('emits GROUP BY SQL for postgres', () => {
    const { text } = PushdownCompiler.toSql({
      schema: 't', table: 'orders', dialect: 'postgres',
      groupBy: ['region'],
      aggregates: [{ func: 'COUNT', column: null, alias: 'n' }, { func: 'SUM', column: 'amount', alias: 'total' }],
    });
    expect(text).toBe('SELECT "region", COUNT(*) AS "n", SUM("amount") AS "total" FROM "t"."orders" GROUP BY "region"');
  });

  it('builds a Mongo $group aggregation pipeline', () => {
    const pipeline = PushdownCompiler.toMongoAggregate({
      groupBy: ['status'],
      aggregates: [{ func: 'COUNT', column: null, alias: 'n' }, { func: 'AVG', column: 'price', alias: 'p' }],
    });
    expect(pipeline[0]).toEqual({ $group: { _id: { status: '$status' }, n: { $sum: 1 }, p: { $avg: '$price' } } });
    expect(pipeline[1]).toEqual({ $project: { _id: 0, status: '$_id.status', n: '$n', p: '$p' } });
  });
});
