import { SavedAnalyticsService } from './analytics.service';

describe('SavedAnalyticsService — variable binding', () => {
  const vars = [
    { name: 'region', type: 'string' as const, required: true },
    { name: 'minAmount', type: 'number' as const, default: 0 },
    { name: 'active', type: 'boolean' as const, default: true },
  ];

  it('resolveValues applies types, defaults, and required checks', () => {
    const v = SavedAnalyticsService.resolveValues(vars, { region: 'EU', minAmount: '100', active: 'false' });
    expect(v).toEqual({ region: 'EU', minAmount: 100, active: false });
    const d = SavedAnalyticsService.resolveValues(vars, { region: 'NA' });
    expect(d).toEqual({ region: 'NA', minAmount: 0, active: true });
    expect(() => SavedAnalyticsService.resolveValues(vars, {})).toThrow(/required variable "region"/);
  });

  it('bindAst replaces a whole-string token with the TYPED value, embedded tokens as string', () => {
    const ast = {
      from: { resource: 'orders' },
      where: [
        { column: 'region', operator: 'EQ', value: '{{region}}' },
        { column: 'amount', operator: 'GTE', value: '{{minAmount}}' },
      ],
      note: 'region={{region}} min={{minAmount}}',
    };
    const bound = SavedAnalyticsService.bindAst(ast, { region: 'EU', minAmount: 100 });
    expect(bound.where[0].value).toBe('EU');       // string
    expect(bound.where[1].value).toBe(100);        // number (typed, not "100")
    expect(bound.note).toBe('region=EU min=100');  // embedded → interpolated
  });

  it('bindSql escapes literals (numbers bare, strings quoted, quotes doubled)', () => {
    const sql = "SELECT * FROM t WHERE region = {{region}} AND amount >= {{minAmount}} AND ok = {{active}}";
    expect(SavedAnalyticsService.bindSql(sql, { region: "O'Brien", minAmount: 50, active: true }))
      .toBe("SELECT * FROM t WHERE region = 'O''Brien' AND amount >= 50 AND ok = TRUE");
  });
});
