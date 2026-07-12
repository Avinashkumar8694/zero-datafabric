import { GrantService } from './grant.service';

describe('GrantService.decide — engine-agnostic privilege decisions', () => {
  const grants = [{ role: 'ANALYST', privileges: ['SELECT' as const] }, { role: 'WRITER', privileges: ['SELECT' as const, 'INSERT' as const] }];

  it('default-allows when no grants are declared (ungoverned)', () => {
    expect(GrantService.decide([], 'ANYONE', 'SELECT')).toEqual({ allowed: true, governed: false });
  });

  it('ADMIN and SYSTEM bypass a governed table', () => {
    expect(GrantService.decide(grants, 'ADMIN', 'DELETE')).toEqual({ allowed: true, governed: true });
    expect(GrantService.decide(grants, 'SYSTEM', 'INSERT')).toEqual({ allowed: true, governed: true });
  });

  it('allows a role that holds the privilege', () => {
    expect(GrantService.decide(grants, 'ANALYST', 'SELECT')).toEqual({ allowed: true, governed: true });
    expect(GrantService.decide(grants, 'WRITER', 'INSERT')).toEqual({ allowed: true, governed: true });
  });

  it('denies a role that lacks the privilege, and an unknown role', () => {
    expect(GrantService.decide(grants, 'ANALYST', 'INSERT')).toEqual({ allowed: false, governed: true });
    expect(GrantService.decide(grants, 'GUEST', 'SELECT')).toEqual({ allowed: false, governed: true });
    expect(GrantService.decide(grants, undefined, 'SELECT')).toEqual({ allowed: false, governed: true });
  });
});
