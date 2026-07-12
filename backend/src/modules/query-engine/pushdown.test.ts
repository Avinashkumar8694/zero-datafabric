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

  describe('toJoinSql (co-located pushdown)', () => {
    const resolve = (_source: string | undefined, resource: string) => ({ schema: 'public', table: resource });

    it('compiles a self-join + GROUP BY + aggregate as ONE parameterized statement', () => {
      const ast = {
        from: { resource: 'remote_table', source: 'Remote_PG', alias: 'a' },
        joins: [{ type: 'INNER', resource: 'remote_table', source: 'Remote_PG', alias: 'b', on: { left: 'a.id', operator: 'EQ', right: 'b.id' } }],
        groupBy: ['a.value'],
        select: ['a.value', { aggregate: 'COUNT', column: '*', alias: 'n' }],
        where: [{ column: 'a.id', operator: 'GT', value: 0 }],
      };
      const { text, params } = PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve });
      expect(text).toBe(
        'SELECT "a"."value", COUNT(*) AS "n" FROM "public"."remote_table" "a" ' +
        'INNER JOIN "public"."remote_table" "b" ON "a"."id" = "b"."id" ' +
        'WHERE "a"."id" > $1 GROUP BY "a"."value"'
      );
      expect(params).toEqual([0]);
    });

    it('parameterizes IN lists and honours HAVING + ORDER BY + LIMIT', () => {
      const ast = {
        from: { resource: 'orders', source: 'PG', alias: 'o' },
        select: ['o.region', { aggregate: 'SUM', column: 'o.total', alias: 'rev' }],
        where: [{ column: 'o.status', operator: 'IN', value: ['PAID', 'SHIPPED'] }],
        groupBy: ['o.region'],
        having: [{ column: 'o.region', operator: 'NE', value: 'XX' }],
        orderBy: [{ column: 'rev', direction: 'DESC' }],
        limit: 10,
      };
      const { text, params } = PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve });
      expect(text).toContain('"o"."status" IN ($1, $2)');
      expect(text).toContain('GROUP BY "o"."region"');
      expect(text).toContain('HAVING "o"."region" != $3');
      expect(text).toContain('ORDER BY "rev" DESC');
      expect(text).toMatch(/LIMIT 10$/);
      expect(params).toEqual(['PAID', 'SHIPPED', 'XX']);
    });

    it('emits Oracle row-limiting + :n binds and no AS for table aliases', () => {
      const ast = {
        from: { resource: 'emp', source: 'ORA', alias: 'e' },
        joins: [{ type: 'LEFT', resource: 'dept', source: 'ORA', alias: 'd', on: { left: 'e.deptno', operator: 'EQ', right: 'd.deptno' } }],
        where: [{ column: 'e.sal', operator: 'GTE', value: 1000 }],
        limit: 5,
      };
      const { text, params } = PushdownCompiler.toJoinSql({ ast, dialect: 'oracle', resolve });
      expect(text).toContain('FROM "PUBLIC"."EMP" "E"');            // uppercased quoted idents, no AS
      expect(text).toContain('LEFT JOIN "PUBLIC"."DEPT" "D" ON "E"."DEPTNO" = "D"."DEPTNO"');
      expect(text).toContain('"E"."SAL" >= :1');
      expect(text).toMatch(/FETCH FIRST 5 ROWS ONLY$/);
      expect(params).toEqual([1000]);
    });

    it('rejects raw expressions so the caller falls back to federation', () => {
      const ast = {
        from: { resource: 't', source: 'PG', alias: 't' },
        select: [{ expression: 'now() - created_at', alias: 'age' }],
      };
      expect(() => PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve })).toThrow(/unsupported SELECT/i);
    });

    it('rejects an unknown operator (no raw operator injection)', () => {
      const ast = {
        from: { resource: 't', source: 'PG', alias: 't' },
        where: [{ column: 't.x', operator: 'DROP', value: 1 }],
      };
      expect(() => PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve })).toThrow(/unsupported operator/i);
    });

    it('compiles a non-recursive WITH (CTE) as native SQL, CTE ref not schema-qualified', () => {
      const ast = {
        with: [{ name: 'lo', columns: ['id', 'value'], base: { from: { resource: 'remote_table', source: 'PG' }, select: ['id', 'value'], where: [{ column: 'id', operator: 'LTE', value: 4 }] } }],
        from: { resource: 'lo' },
        select: ['id', 'value'],
        limit: 10,
      };
      const { text, params } = PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve });
      expect(text).toBe(
        'WITH "lo"("id", "value") AS (SELECT "id", "value" FROM "public"."remote_table" WHERE "id" <= $1) ' +
        'SELECT "id", "value" FROM "lo" LIMIT 10'
      );
      expect(params).toEqual([4]);
    });

    it('rejects a recursive CTE (unionAll) so it falls back to the recursive executor', () => {
      const ast = { with: [{ name: 'r', columns: ['n'], base: { from: { resource: 't', source: 'PG' }, select: ['n'] }, unionAll: { from: { resource: 't', source: 'PG' }, select: ['n'] } }], from: { resource: 'r' }, select: ['n'], limit: 5 };
      expect(() => PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve })).toThrow(/recursive CTE/i);
    });

    it('compiles a co-located UNION of two legs', () => {
      const ast = {
        union: [
          { from: { resource: 'a', source: 'PG', alias: 'a' }, select: ['a.id'] },
          { from: { resource: 'b', source: 'PG', alias: 'b' }, select: ['b.id'] },
        ],
      };
      const { text } = PushdownCompiler.toJoinSql({ ast, dialect: 'postgres', resolve });
      expect(text).toBe('(SELECT "a"."id" FROM "public"."a" "a") UNION (SELECT "b"."id" FROM "public"."b" "b")');
    });
  });
});
