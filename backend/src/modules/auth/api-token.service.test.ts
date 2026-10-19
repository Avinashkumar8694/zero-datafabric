import { requiredScope, TOKEN_SCOPES } from './api-token.service';

describe('API token scope mapping', () => {
  it('maps read/write methods to scopes', () => {
    expect(requiredScope('POST', '/api/queries/engine')).toBe('query:read');
    expect(requiredScope('POST', '/api/analytics/query')).toBe('query:read');
    expect(requiredScope('GET', '/api/data/orders')).toBe('data:read');
    expect(requiredScope('POST', '/api/data/orders')).toBe('data:write');
    expect(requiredScope('DELETE', '/api/data/orders')).toBe('data:write');
    expect(requiredScope('GET', '/api/metadata/catalog')).toBe('metadata:read');
    expect(requiredScope('POST', '/api/metadata/apply')).toBe('metadata:write');
    expect(requiredScope('POST', '/api/triggers')).toBe('triggers:write');
  });

  it('treats read-only POSTs as reads and mutating ASTs as writes', () => {
    expect(requiredScope('POST', '/api/data/fetch')).toBe('data:read');
    expect(requiredScope('POST', '/api/metadata/diff')).toBe('metadata:read');
    expect(requiredScope('POST', '/api/queries/engine', { type: 'SELECT' })).toBe('query:read');
    expect(requiredScope('POST', '/api/queries/engine', { config: { type: 'CALL' } })).toBe('data:write');
    expect(requiredScope('POST', '/api/analytics/query', { type: 'insert' })).toBe('data:write');
    expect(requiredScope('POST', '/api/queries/transpile', { type: 'CALL' })).toBe('query:read');
  });

  it('never allows tokens on admin/session/billing surfaces', () => {
    for (const p of ['/api/admin/workers', '/api/admin/users', '/api/developer/tokens', '/api/tenants', '/api/settings/login', '/api/plans', '/api/subscriptions/me', '/api/auth/token', '/api/replication/jobs', '/api/policies', '/api/grants']) {
      expect(requiredScope('GET', p)).toBeNull();
      expect(requiredScope('POST', p)).toBeNull();
    }
  });

  it('does not match look-alike prefixes', () => {
    expect(requiredScope('GET', '/api/dataset')).toBeNull();
    expect(requiredScope('GET', '/api/queriesx')).toBeNull();
    expect(requiredScope('GET', '/api/../admin')).toBeNull();
  });

  it('has no admin scope to grant', () => {
    expect(TOKEN_SCOPES.some(s => s.startsWith('admin'))).toBe(false);
  });
});
