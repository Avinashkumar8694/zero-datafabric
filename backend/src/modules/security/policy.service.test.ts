import { PolicyService, SessionCtx } from './policy.service';

const session: SessionCtx = { tenantId: 'tenant_A', role: 'ANALYST', region: 'EU', username: 'alice' };

describe('PolicyService — engine-agnostic policy compilation', () => {
  describe('compileFilter', () => {
    it('resolves a session reference (tenant isolation)', () => {
      const f = PolicyService.compileFilter([{ column: 'tenant_id', operator: 'EQ', value: { session: 'tenant_id' } }], session);
      expect(f).toEqual({ tenant_id: { $eq: 'tenant_A' } });
    });

    it('resolves the region session ref', () => {
      const f = PolicyService.compileFilter([{ column: 'region', operator: 'EQ', value: { session: 'region' } }], session);
      expect(f).toEqual({ region: { $eq: 'EU' } });
    });

    it('maps IS_NULL / IS_NOT_NULL to $eq/$ne null (hide-deleted)', () => {
      expect(PolicyService.compileFilter([{ column: 'deleted_at', operator: 'IS_NULL' }], session))
        .toEqual({ deleted_at: { $eq: null } });
      expect(PolicyService.compileFilter([{ column: 'deleted_at', operator: 'IS_NOT_NULL' }], session))
        .toEqual({ deleted_at: { $ne: null } });
    });

    it('supports IN, comparison ops, and literal values', () => {
      const f = PolicyService.compileFilter([
        { column: 'status', operator: 'IN', value: ['ACTIVE', 'PENDING'] },
        { column: 'amount', operator: 'GTE', value: 100 },
      ], session);
      expect(f).toEqual({ status: { $in: ['ACTIVE', 'PENDING'] }, amount: { $gte: 100 } });
    });

    it('merges multiple clauses on the same column (range)', () => {
      const f = PolicyService.compileFilter([
        { column: 'amount', operator: 'GTE', value: 10 },
        { column: 'amount', operator: 'LTE', value: 99 },
      ], session);
      expect(f).toEqual({ amount: { $gte: 10, $lte: 99 } });
    });
  });

  describe('mergeIntoFilter', () => {
    it('merges a policy predicate into an existing operator filter', () => {
      const merged = PolicyService.mergeIntoFilter({ amount: { $gte: 10 } }, { tenant_id: { $eq: 'tenant_A' } });
      expect(merged).toEqual({ amount: { $gte: 10 }, tenant_id: { $eq: 'tenant_A' } });
    });

    it('combines a bare-equality user filter with a policy condition on the same column', () => {
      const merged = PolicyService.mergeIntoFilter({ region: 'EU' }, { region: { $ne: null } });
      expect(merged).toEqual({ region: { $eq: 'EU', $ne: null } });
    });

    it('policy filter wins when no existing filter', () => {
      expect(PolicyService.mergeIntoFilter(undefined, { tenant_id: { $eq: 'x' } })).toEqual({ tenant_id: { $eq: 'x' } });
    });
  });

  describe('applyMasks', () => {
    const rows = () => [{ id: 1, email: 'alice@example.com', ssn: '123456789', note: null }];

    it('REDACT / NULL / PARTIAL / HASH strategies', () => {
      const out = PolicyService.applyMasks(rows(), [
        { column: 'email', strategy: 'REDACT' },
        { column: 'ssn', strategy: 'PARTIAL' },
      ], session);
      expect(out[0].email).toBe('***REDACTED***');
      expect(out[0].ssn).toBe('*****6789');

      const nulled = PolicyService.applyMasks(rows(), [{ column: 'email', strategy: 'NULL' }], session);
      expect(nulled[0].email).toBeNull();

      const hashed = PolicyService.applyMasks(rows(), [{ column: 'email', strategy: 'HASH' }], session);
      expect(hashed[0].email).toMatch(/^sha256:[0-9a-f]{8}$/);
    });

    it('leaves null values and absent columns untouched; does not mutate input', () => {
      const input = rows();
      const out = PolicyService.applyMasks(input, [
        { column: 'note', strategy: 'REDACT' },  // value is null → unchanged
        { column: 'missing', strategy: 'REDACT' }, // absent → no-op
      ], session);
      expect(out[0].note).toBeNull();
      expect('missing' in out[0]).toBe(false);
      expect(input[0].email).toBe('alice@example.com'); // original not mutated
    });
  });

  describe('physicalSchema', () => {
    it('prefixes a logical schema, leaves physical untouched', () => {
      expect(PolicyService.physicalSchema('tenant_A', 'Sales')).toBe('tenant_tenant_A_Sales');
      expect(PolicyService.physicalSchema('tenant_A', 'tenant_tenant_A_Sales')).toBe('tenant_tenant_A_Sales');
    });
  });
});
