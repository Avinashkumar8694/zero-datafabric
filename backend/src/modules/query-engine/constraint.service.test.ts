import { ConstraintService, ConstraintSpec } from './constraint.service';

describe('ConstraintService — engine-agnostic validation', () => {
  const spec: ConstraintSpec = {
    columns: [
      { name: 'sku', notNull: true, unique: true },
      { name: 'status', enum: ['ACTIVE', 'DISCONTINUED'] },
    ],
    checks: [
      { name: 'qty_non_negative', column: 'qty', op: 'GTE', value: 0 },
      { name: 'region_format', column: 'region', op: 'REGEX', value: '^[A-Z]{2,3}$' },
    ],
  };

  it('accepts a valid row', async () => {
    const v = await ConstraintService.validate([{ sku: 'A', status: 'ACTIVE', qty: 3, region: 'EU' }], spec, 'create');
    expect(v).toHaveLength(0);
  });

  it('flags NOT NULL on create', async () => {
    const v = await ConstraintService.validate([{ status: 'ACTIVE', qty: 1 }], spec, 'create');
    expect(v.some((x) => x.rule === 'NOT_NULL' && x.column === 'sku')).toBe(true);
  });

  it('flags ENUM, CHECK-comparison, and CHECK-regex violations', async () => {
    const v = await ConstraintService.validate([{ sku: 'A', status: 'FROZEN', qty: -1, region: 'europe' }], spec, 'create');
    expect(v.some((x) => x.rule === 'ENUM')).toBe(true);
    expect(v.some((x) => x.rule === 'CHECK(GTE)')).toBe(true);
    expect(v.some((x) => x.rule === 'CHECK(REGEX)')).toBe(true);
  });

  it('on update, only validates columns actually being written', async () => {
    // qty not present → its check is skipped; status present + bad → flagged.
    const v = await ConstraintService.validate([{ status: 'FROZEN' }], spec, 'update');
    expect(v.some((x) => x.rule === 'ENUM')).toBe(true);
    expect(v.some((x) => x.column === 'qty')).toBe(false);
    expect(v.some((x) => x.column === 'sku' && x.rule === 'NOT_NULL')).toBe(false); // sku not being set
  });

  it('UNIQUE and FK use async lookups', async () => {
    const v = await ConstraintService.validate([{ sku: 'DUP', status: 'ACTIVE', qty: 1 }], spec, 'create', {
      countWhere: async () => 1, // pretend a duplicate exists
    });
    expect(v.some((x) => x.rule === 'UNIQUE')).toBe(true);
  });

  it('parses simple Postgres CHECK expressions into structured rules', () => {
    expect(ConstraintService.parseCheckExpression('c1', "region ~ '^[A-Z]{2,3}$'"))
      .toEqual({ name: 'c1', column: 'region', op: 'REGEX', value: '^[A-Z]{2,3}$' });
    expect(ConstraintService.parseCheckExpression('c2', 'qty >= 0'))
      .toEqual({ name: 'c2', column: 'qty', op: 'GTE', value: 0 });
    expect(ConstraintService.parseCheckExpression('c3', "total > (a + b)")).toBeNull(); // unparseable → Postgres-only
  });

  it('builds a spec from a manifest table (column flags + enum ref + CHECK)', () => {
    const built = ConstraintService.specFromManifestTable(
      {
        columns: [
          { name: 'id', primaryKey: true },
          { name: 'status', type: 'ENUM', ref: 'shipment_status' },
          { name: 'name', nullable: false },
        ],
        constraints: [{ name: 'chk', type: 'CHECK', expression: "region ~ '^[A-Z]{2,3}$'" }],
      },
      { shipment_status: ['PENDING', 'DELIVERED'] }
    );
    expect(built.columns.find((c) => c.name === 'id')).toMatchObject({ notNull: true, unique: true });
    expect(built.columns.find((c) => c.name === 'status')?.enum).toEqual(['PENDING', 'DELIVERED']);
    expect(built.checks[0]).toMatchObject({ column: 'region', op: 'REGEX' });
  });
});
