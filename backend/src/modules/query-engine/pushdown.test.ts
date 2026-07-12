import { PushdownCompiler } from './pushdown';

describe('PushdownCompiler', () => {
  describe('toSql (postgres)', () => {
    it('pushes filter operators as parameterized predicates', () => {
      const { text, params } = PushdownCompiler.toSql({
        schema: 'tenant_x',
        table: 'orders',
        dialect: 'postgres',
        filter: { age: { $gt: 18 }, email: { $like: '%@zero.io' } },
      });
      expect(text).toContain('FROM "tenant_x"."orders"');
      expect(text).toContain('"age" > $1');
      expect(text).toContain('"email" LIKE $2');
      expect(params).toEqual([18, '%@zero.io']);
    });

    it('pushes projection, order, limit and offset', () => {
      const { text } = PushdownCompiler.toSql({
        table: 'orders',
        dialect: 'postgres',
        select: ['id', 'sku'],
        orderBy: [{ field: 'id', dir: 'DESC' }],
        limit: 25,
        offset: 5,
      });
      expect(text).toBe('SELECT "id", "sku" FROM "orders" ORDER BY "id" DESC LIMIT 25 OFFSET 5');
    });

    it('handles $in with a placeholder list', () => {
      const { text, params } = PushdownCompiler.toSql({
        table: 't',
        dialect: 'postgres',
        filter: { status: { $in: ['A', 'B'] } },
      });
      expect(text).toContain('"status" IN ($1, $2)');
      expect(params).toEqual(['A', 'B']);
    });

    it('treats a bare value as equality', () => {
      const { text, params } = PushdownCompiler.toSql({
        table: 't',
        dialect: 'postgres',
        filter: { id: 7 },
      });
      expect(text).toContain('"id" = $1');
      expect(params).toEqual([7]);
    });
  });

  describe('toSql (mysql)', () => {
    it('uses ? placeholders and backtick identifiers', () => {
      const { text, params } = PushdownCompiler.toSql({
        schema: 'shop',
        table: 'orders',
        dialect: 'mysql',
        filter: { qty: { $gte: 10 } },
        limit: 3,
      });
      expect(text).toContain('FROM `shop`.`orders`');
      expect(text).toContain('`qty` >= ?');
      expect(text).toContain('LIMIT 3');
      expect(params).toEqual([10]);
    });
  });

  describe('toMongo', () => {
    it('maps equality and comparison operators', () => {
      const spec = PushdownCompiler.toMongo({ filter: { status: 'ACTIVE', qty: { $gt: 5 } } });
      expect(spec.filter).toEqual({ status: 'ACTIVE', qty: { $gt: 5 } });
    });

    it('translates $like to an anchored regex', () => {
      const spec = PushdownCompiler.toMongo({ filter: { name: { $ilike: 'ab%' } } });
      expect(spec.filter.name.$regex).toBe('^ab.*$');
      expect(spec.filter.name.$options).toBe('i');
    });

    it('projects, sorts, limits and skips', () => {
      const spec = PushdownCompiler.toMongo({
        select: ['a', 'b'],
        orderBy: [{ field: 'a', dir: 'DESC' }],
        limit: 10,
        offset: 2,
      });
      // _id:0 is added so projected Mongo rows match relational rows (set-ops/joins).
      expect(spec.projection).toEqual({ a: 1, b: 1, _id: 0 });
      expect(spec.sort).toEqual({ a: -1 });
      expect(spec.limit).toBe(10);
      expect(spec.skip).toBe(2);
    });

    it('omits projection when selecting *', () => {
      const spec = PushdownCompiler.toMongo({ select: ['*'] });
      expect(spec.projection).toBeUndefined();
    });
  });
});
