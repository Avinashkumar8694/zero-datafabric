jest.mock('axios', () => jest.fn());

import { ElasticsearchConnector } from './factory';
import { PushdownCompiler } from '../../query-engine/pushdown';

const axios = require('axios') as jest.Mock;

describe('ElasticsearchConnector pushdown', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pushes filters as query-DSL and projection/sort/size', async () => {
    axios.mockResolvedValue({ data: { hits: { hits: [{ _id: '1', _source: { sku: 'A', qty: 9 } }] } } });
    const c = new ElasticsearchConnector({ host: 'localhost', port: 9200 });
    const rows = await c.query('default', 'inventory', {
      filter: { status: { $eq: 'ACTIVE' }, qty: { $gt: 5 } },
      select: ['sku', 'qty'],
      orderBy: [{ field: 'qty', dir: 'DESC' }],
      limit: 25,
    });
    const body = axios.mock.calls[0][0].data;
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([{ term: { status: 'ACTIVE' } }, { range: { qty: { gt: 5 } } }])
    );
    expect(body._source).toEqual(['sku', 'qty']);
    expect(body.sort).toEqual([{ qty: 'desc' }]);
    expect(body.size).toBe(25);
    expect(rows).toEqual([{ _id: '1', sku: 'A', qty: 9 }]);
  });

  it('pushes GROUP BY as terms + metric aggs and flattens buckets', async () => {
    axios.mockResolvedValue({
      data: {
        aggregations: {
          g_0: {
            buckets: [
              { key: 'EU', doc_count: 5, total: { value: 100 } },
              { key: 'US', doc_count: 2, total: { value: 40 } },
            ],
          },
        },
      },
    });
    const c = new ElasticsearchConnector({ host: 'localhost', port: 9200 });
    const rows = await c.query('default', 'orders', {
      groupBy: ['region'],
      aggregates: [
        { func: 'COUNT', column: null, alias: 'n' },
        { func: 'SUM', column: 'amount', alias: 'total' },
      ],
    });
    const body = axios.mock.calls[0][0].data;
    expect(body.size).toBe(0);
    expect(body.aggs.g_0.terms.field).toBe('region');
    expect(body.aggs.g_0.aggs.total).toEqual({ sum: { field: 'amount' } });
    expect(rows).toEqual([
      { region: 'EU', n: 5, total: 100 },
      { region: 'US', n: 2, total: 40 },
    ]);
  });
});

describe('Snowflake dialect SQL', () => {
  it('uses ? binds and double-quoted identifiers', () => {
    const { text, params } = PushdownCompiler.toSql({
      schema: 'ANALYTICS', table: 'ORDERS', dialect: 'snowflake',
      filter: { region: { $eq: 'EU' } }, limit: 10,
    });
    expect(text).toContain('FROM "ANALYTICS"."ORDERS"');
    expect(text).toContain('"region" = ?');
    expect(params).toEqual(['EU']);
  });
});
