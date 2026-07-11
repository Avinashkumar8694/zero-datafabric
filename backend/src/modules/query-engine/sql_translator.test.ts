import { sqlToAst } from './sql_translator';

describe('sqlToAst — SQL → fabric AST translator (for non-SQL engines like MongoDB)', () => {
  it('translates a GROUP BY aggregate', () => {
    const q = sqlToAst('SELECT event_type, COUNT(*) AS n FROM web_events GROUP BY event_type');
    expect(q.from.resource).toBe('web_events');
    expect(q.groupBy).toEqual(['event_type']);
    expect(q.select).toEqual(['event_type', { aggregate: 'COUNT', column: '*', alias: 'n' }]);
  });

  it('translates SUM/AVG with aliases', () => {
    const q = sqlToAst('SELECT region, SUM(amount) AS total, AVG(amount) AS avg_amt FROM orders GROUP BY region');
    expect(q.select).toEqual([
      'region',
      { aggregate: 'SUM', column: 'amount', alias: 'total' },
      { aggregate: 'AVG', column: 'amount', alias: 'avg_amt' },
    ]);
  });

  it('translates WHERE with operators, IN, and literals', () => {
    const q = sqlToAst("SELECT * FROM t WHERE region = 'EU' AND amount >= 100 AND status IN ('A','B')");
    expect(q.where).toEqual([
      { column: 'region', operator: 'EQ', value: 'EU' },
      { column: 'amount', operator: 'GTE', value: 100 },
      { column: 'status', operator: 'IN', value: ['A', 'B'] },
    ]);
  });

  it('translates ORDER BY, LIMIT, OFFSET', () => {
    const q = sqlToAst('SELECT id FROM t ORDER BY id DESC LIMIT 5 OFFSET 10');
    expect(q.orderBy).toEqual([{ column: 'id', direction: 'DESC' }]);
    expect(q.limit).toBe(5);
    expect(q.offset).toBe(10);
  });

  it('strips schema qualifiers and quotes from the table', () => {
    expect(sqlToAst('SELECT * FROM public.web_events LIMIT 1').from.resource).toBe('web_events');
    expect(sqlToAst('SELECT * FROM "web_events" LIMIT 1').from.resource).toBe('web_events');
  });

  it('rejects JOINs with guidance to use AST mode', () => {
    expect(() => sqlToAst('SELECT * FROM a JOIN b ON a.id=b.id')).toThrow(/JOIN/i);
  });

  it('rejects set operations and subqueries', () => {
    expect(() => sqlToAst('SELECT id FROM a UNION SELECT id FROM b')).toThrow(/set operation/i);
    expect(() => sqlToAst('SELECT * FROM (SELECT * FROM a) x')).toThrow(/subquer/i);
  });

  it('translates SELECT DISTINCT into a GROUP BY on the columns', () => {
    const q = sqlToAst('SELECT DISTINCT device, region FROM web_events');
    expect(q.groupBy).toEqual(['device', 'region']);
  });

  it('translates HAVING (alias and aggregate expr) into result-column predicates', () => {
    const q = sqlToAst('SELECT event_type, COUNT(*) AS n FROM web_events GROUP BY event_type HAVING COUNT(*) > 1000');
    expect(q.groupBy).toEqual(['event_type']);
    expect(q.having).toEqual([{ column: 'n', operator: 'GT', value: 1000 }]);
    const q2 = sqlToAst('SELECT region, SUM(amount) AS total FROM orders GROUP BY region HAVING total >= 500');
    expect(q2.having).toEqual([{ column: 'total', operator: 'GTE', value: 500 }]);
  });

  it('rejects untranslatable expressions (sequences / functions / window / CASE) — no silent mistranslation', () => {
    expect(() => sqlToAst("SELECT nextval('seq') FROM t LIMIT 1")).toThrow(/unsupported SELECT expression/i);
    expect(() => sqlToAst('SELECT generate_custom_id(region) FROM t LIMIT 1')).toThrow(/unsupported SELECT expression/i);
    expect(() => sqlToAst('SELECT RANK() OVER (ORDER BY x) FROM t LIMIT 1')).toThrow(/unsupported/i);
    expect(() => sqlToAst('SELECT price * qty FROM t LIMIT 1')).toThrow(/unsupported/i);
  });
});
