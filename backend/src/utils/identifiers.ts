/**
 * Shared identifier safety helpers. Every SQL identifier that originates from a
 * request, manifest or stored config must pass through one of these before it
 * is interpolated into a statement (identifiers cannot be bound parameters).
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Tenant ids end up inside schema names (`tenant_<id>[_<logical>]`), so they are kept to a conservative alphabet. */
const TENANT_ID_RE = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;

export class IdentifierError extends Error {
  status = 400;
  code = 'INVALID_IDENTIFIER';
}

/** Returns the identifier unchanged when it is a plain SQL identifier, otherwise throws IdentifierError. */
export function assertIdent(value: unknown, what = 'identifier'): string {
  if (typeof value !== 'string' || !IDENT_RE.test(value)) throw new IdentifierError(`Invalid ${what}: must match [A-Za-z_][A-Za-z0-9_]{0,62}`);
  return value;
}

/** Double-quote an identifier after validating it. */
export function quoteIdent(value: unknown, what = 'identifier'): string {
  return `"${assertIdent(value, what)}"`;
}

/** Quote an identifier that may legitimately contain other characters (e.g. a physical table name read from the catalog): validates there is no NUL and doubles embedded quotes. */
export function quoteAnyIdent(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 128) throw new IdentifierError('Invalid identifier');
  return `"${value.replace(/"/g, '""')}"`;
}

export function assertTenantId(value: unknown): string {
  if (typeof value !== 'string' || !TENANT_ID_RE.test(value)) throw new IdentifierError('Invalid tenant id: letters, digits and underscores, starting with a letter (2-41 chars)');
  return value;
}

/** Escape LIKE wildcards (`_`, `%`, `\`) so a tenant id matches literally in `LIKE 'tenant_<id>%' ESCAPE '\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Exact tenant-schema check: `tenant_<id>` or `tenant_<id>_<logical>` where <id> is exactly this tenant (callers must also enforce the no-prefix-overlap rule on tenant ids). */
export function belongsToTenant(schemaName: string, tenantId: string): boolean {
  const base = `tenant_${tenantId}`;
  return schemaName === base || schemaName.startsWith(`${base}_`);
}
