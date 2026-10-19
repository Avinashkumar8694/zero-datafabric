/**
 * Trigger definition validation. Triggers are compiled to DDL / plpgsql and deployed as the database owner,
 * so every name, URL, expression and size is checked before a definition is stored or compiled, and the
 * target schema/table is confined to the caller's tenant (`tenant_<id>` / `tenant_<id>_<logical>`).
 */
import { assertIdent, assertTenantId, belongsToTenant, IdentifierError } from '../../utils/identifiers';
import { assertSafeWebhookUrl, NetGuardError } from '../integration/net_guard';

export class TriggerValidationError extends Error {
  status = 400;
  constructor(public code: string, message: string) {
    super(message);
  }
}

export const SYSTEM_PLACEHOLDER = '__SYSTEM__';
const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const EXECUTE_TYPES = new Set(['FUNCTION', 'WEBHOOK', 'EXCEPTION', 'AUDIT', 'EMAIL', 'TELEGRAM']);
const EVENT_RE = /^(BEFORE|AFTER|INSTEAD_OF)_(INSERT|UPDATE|DELETE|TRUNCATE)$/;
const EVENT_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']);
const TIMINGS = new Set(['BEFORE', 'AFTER', 'INSTEAD OF', 'INSTEAD_OF']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const COND_OPS = new Set(['GT', 'LT', 'EQ', 'GTE', 'LTE', 'NEQ', 'NE', '>', '<', '=', '>=', '<=', '!=', '<>', 'IS_NULL', 'IS_NOT_NULL']);
const ACTION_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE', 'RAISE', 'EXCEPTION', 'PERFORM', 'FUNCTION']);
const SCHEDULE_UNITS = new Set(['SECOND', 'MINUTE', 'HOUR', 'DAY', 'MONTH']);
const AUTH_TYPES = new Set(['NONE', 'BASIC', 'BEARER', 'OIDC']);
const DEF_KEYS = new Set(['name', 'event', 'events', 'timing', 'execution', 'forEach', 'scope', 'condition', 'execute', 'action', 'procedure', 'function', 'schedule', 'autoDrop', 'source', 'kind', 'description', 'enabled', 'status', 'comment']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface TriggerValidationOptions {
  /** platform admin / explicitly allowed owner: raw `action.sql` accepted */
  allowFreeSql?: boolean;
  /** when set, dotted `schema.name` references must be inside this tenant's namespace */
  tenantId?: string;
  env?: NodeJS.ProcessEnv;
}

const isObj = (x: any): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (code: string, msg: string): never => { throw new TriggerValidationError(code, msg); };

function ident(v: any, what: string): string {
  try { return assertIdent(v, what); } catch (e: any) { if (e instanceof IdentifierError) return fail('INVALID_IDENTIFIER', e.message); throw e; }
}

function qualified(v: any, what: string, opts: TriggerValidationOptions): string {
  if (typeof v !== 'string' || !v) return fail('INVALID_IDENTIFIER', `${what} is required`);
  if (!v.includes('.')) return ident(v, what);
  const parts = v.split('.');
  if (parts.length !== 2) return fail('INVALID_IDENTIFIER', `${what}: only schema.name is allowed`);
  const schema = ident(parts[0], `${what} schema`);
  ident(parts[1], `${what} name`);
  if (!opts.tenantId) return fail('CROSS_TENANT', `${what}: qualified names are not allowed here`);
  if (!belongsToTenant(schema, opts.tenantId)) return fail('CROSS_TENANT', `${what}: schema "${schema}" is outside your workspace`);
  return v;
}

function scan(node: any, depth = 0) {
  if (depth > 12) fail('TOO_DEEP', 'definition is nested too deeply');
  if (Array.isArray(node)) { node.forEach((v) => scan(v, depth + 1)); return; }
  if (isObj(node)) {
    for (const k of Object.getOwnPropertyNames(node)) {
      if (FORBIDDEN_KEYS.has(k)) fail('FORBIDDEN_KEY', `key "${k}" is not allowed`);
      scan(node[k], depth + 1);
    }
  }
}

function str(v: any, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) return fail('INVALID_VALUE', `${what} must be a string up to ${max} characters`);
  return v;
}

function intIn(v: any, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return fail('INVALID_VALUE', `${what} must be an integer between ${min} and ${max}`);
  return v;
}

function validateCondition(c: any, what: string, depth = 0, counter = { n: 0 }) {
  if (c === null || c === undefined) return;
  if (depth > 6 || ++counter.n > 50) fail('TOO_COMPLEX', `${what} is too complex`);
  if (typeof c === 'string') return; // legacy string form is compiled as a quoted literal
  if (!isObj(c)) return fail('INVALID_CONDITION', `${what} must be an object`);
  if (Array.isArray(c.and)) { c.and.forEach((x: any) => validateCondition(x, what, depth + 1, counter)); return; }
  if (Array.isArray(c.or)) { c.or.forEach((x: any) => validateCondition(x, what, depth + 1, counter)); return; }
  const op = String(c.operator ?? c.op ?? 'EQ').toUpperCase();
  if (!COND_OPS.has(op)) fail('INVALID_CONDITION', `${what}: unsupported operator "${op.slice(0, 20)}"`);
  for (const side of ['left', 'right']) {
    const v = c[side];
    if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') fail('INVALID_CONDITION', `${what}.${side} must be a scalar`);
    if (typeof v === 'string' && (v.length > 200 || v.includes('\0'))) fail('INVALID_CONDITION', `${what}.${side} is too long`);
  }
}

function validateUrl(v: any, what: string, opts: TriggerValidationOptions) {
  try { assertSafeWebhookUrl(v, opts.env ? { env: opts.env } : {}); } catch (e: any) {
    if (e instanceof NetGuardError) return fail(e.code, `${what}: ${e.message}`);
    throw e;
  }
}

function validateExecute(ex: any, opts: TriggerValidationOptions) {
  if (!isObj(ex)) return fail('INVALID_EXECUTE', 'execute must be an object');
  const type = String(ex.type || '').toUpperCase();
  if (!EXECUTE_TYPES.has(type)) fail('INVALID_EXECUTE', `execute.type must be one of ${[...EXECUTE_TYPES].join(', ')}`);
  const known = new Set(['type', 'name', 'url', 'method', 'payload', 'params', 'headers', 'auth', 'message', 'when', 'timeoutMs']);
  const unknown = Object.keys(ex).filter((k) => !known.has(k));
  if (unknown.length) fail('UNKNOWN_KEYS', `execute: unknown key(s): ${unknown.slice(0, 5).join(', ')}`);
  if (type === 'FUNCTION') qualified(ex.name, 'execute.name', opts);
  if (type === 'EXCEPTION') {
    if (ex.message != null) str(ex.message, 'execute.message', 500);
    validateCondition(ex.when, 'execute.when');
  }
  if (ex.url != null) validateUrl(ex.url, 'execute.url', opts);
  if (ex.method != null && !METHODS.has(String(ex.method).toUpperCase())) fail('INVALID_METHOD', `execute.method must be one of ${[...METHODS].join(', ')}`);
  if (ex.headers != null) {
    if (!isObj(ex.headers) || Object.keys(ex.headers).length > 20) fail('INVALID_HEADERS', 'execute.headers must be an object with at most 20 entries');
    for (const [k, v] of Object.entries(ex.headers)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(k)) fail('INVALID_HEADERS', `invalid header name "${k.slice(0, 30)}"`);
      if (typeof v !== 'string' || v.length > 4096 || /[\r\n\0]/.test(v)) fail('INVALID_HEADERS', `invalid value for header "${k}"`);
      if (/^(host|content-length|transfer-encoding|connection)$/i.test(k)) fail('INVALID_HEADERS', `header "${k}" cannot be set`);
    }
  }
  if (ex.auth != null) {
    if (!isObj(ex.auth)) fail('INVALID_AUTH', 'execute.auth must be an object');
    const at = String(ex.auth.type || 'NONE').toUpperCase();
    if (!AUTH_TYPES.has(at)) fail('INVALID_AUTH', 'execute.auth.type must be NONE, BASIC, BEARER or OIDC');
    for (const k of ['username', 'password', 'token', 'clientId', 'clientSecret', 'scope', 'audience']) if (ex.auth[k] != null) str(ex.auth[k], `execute.auth.${k}`, 4096);
    if (ex.auth.tokenEndpoint != null) validateUrl(ex.auth.tokenEndpoint, 'execute.auth.tokenEndpoint', opts);
  }
  for (const k of ['payload', 'params']) {
    if (ex[k] != null && JSON.stringify(ex[k]).length > MAX_PAYLOAD_BYTES) fail('TOO_LARGE', `execute.${k} is larger than ${MAX_PAYLOAD_BYTES / 1024} KB`);
  }
  if (ex.timeoutMs != null) intIn(ex.timeoutMs, 'execute.timeoutMs', 100, 60000);
}

function validateAction(a: any, opts: TriggerValidationOptions) {
  if (!isObj(a)) return fail('INVALID_ACTION', 'action must be an object');
  if (a.sql != null) {
    if (!opts.allowFreeSql) fail('FREE_SQL_NOT_ALLOWED', 'FREE_SQL_NOT_ALLOWED: action.sql is free-form SQL, which is not allowed for this account (use a structured action, or ask a platform admin)');
    str(a.sql, 'action.sql', 5000);
    if (/\$[A-Za-z0-9_]*\$/.test(a.sql)) fail('INVALID_ACTION', 'action.sql must not contain dollar-quote delimiters');
    return;
  }
  const type = String(a.type || '').toUpperCase();
  if (!ACTION_TYPES.has(type)) fail('INVALID_ACTION', `action.type must be one of ${[...ACTION_TYPES].join(', ')}`);
  if (type === 'INSERT') {
    qualified(a.into || a.table, 'action.into', opts);
    if (!isObj(a.values)) fail('INVALID_ACTION', 'INSERT action needs values');
    const keys = Object.keys(a.values);
    if (!keys.length || keys.length > 100) fail('INVALID_ACTION', 'INSERT action needs 1-100 values');
    keys.forEach((k) => ident(k, 'action.values column'));
  } else if (type === 'UPDATE') {
    qualified(a.table || a.into, 'action.table', opts);
    if (!isObj(a.set) || !Object.keys(a.set).length || Object.keys(a.set).length > 100) fail('INVALID_ACTION', 'UPDATE action needs 1-100 set values');
    Object.keys(a.set).forEach((k) => ident(k, 'action.set column'));
    if (!a.where) fail('INVALID_ACTION', 'UPDATE action requires where');
    validateCondition(a.where, 'action.where');
  } else if (type === 'DELETE') {
    qualified(a.from || a.table, 'action.from', opts);
    if (!a.where) fail('INVALID_ACTION', 'DELETE action requires where');
    validateCondition(a.where, 'action.where');
  } else if (type === 'RAISE' || type === 'EXCEPTION') {
    if (a.message != null) str(a.message, 'action.message', 500);
    validateCondition(a.when, 'action.when');
  } else {
    qualified(a.function || a.name, 'action.function', opts);
    if (a.args != null && (!Array.isArray(a.args) || a.args.length > 20)) fail('INVALID_ACTION', 'action.args must be an array of up to 20');
  }
}

function validateSchedule(s: any) {
  if (!isObj(s)) return fail('INVALID_SCHEDULE', 'schedule must be an object');
  const type = String(s.type || '').toUpperCase();
  if (!['FIXED', 'RELATIVE', 'CRON'].includes(type)) fail('INVALID_SCHEDULE', 'schedule.type must be FIXED, RELATIVE or CRON');
  if (s.cron != null && (typeof s.cron !== 'string' || s.cron.length > 100 || !/^[0-9*/,\-A-Za-z? ]+$/.test(s.cron))) fail('INVALID_SCHEDULE', 'schedule.cron is not a valid cron expression');
  if (type === 'CRON' && s.cron == null) fail('INVALID_SCHEDULE', 'schedule.cron is required for CRON schedules');
  if (s.every != null) intIn(s.every, 'schedule.every', 1, 1_000_000);
  if (s.after != null) intIn(s.after, 'schedule.after', 0, 1_000_000);
  if (s.maxAttempts != null) intIn(s.maxAttempts, 'schedule.maxAttempts', 1, 20);
  if (s.unit != null && !SCHEDULE_UNITS.has(String(s.unit).toUpperCase())) fail('INVALID_SCHEDULE', `schedule.unit must be one of ${[...SCHEDULE_UNITS].join(', ')}`);
  for (const k of ['column', 'relativeColumn']) if (s[k] != null) ident(s[k], `schedule.${k}`);
  const unknown = Object.keys(s).filter((k) => !['type', 'cron', 'every', 'after', 'unit', 'column', 'relativeColumn', 'maxAttempts'].includes(k));
  if (unknown.length) fail('UNKNOWN_KEYS', `schedule: unknown key(s): ${unknown.slice(0, 5).join(', ')}`);
}

/** Validates the shape and every embedded value of a trigger definition (registry `definition` or a manifest trigger). */
export function validateTriggerDefinition(def: any, opts: TriggerValidationOptions = {}): void {
  if (!isObj(def)) fail('INVALID_DEFINITION', 'definition must be an object');
  scan(def);
  let size = 0;
  try { size = JSON.stringify(def).length; } catch { fail('INVALID_DEFINITION', 'definition is not serialisable'); }
  if (size > MAX_DEFINITION_BYTES) fail('TOO_LARGE', `definition is larger than ${MAX_DEFINITION_BYTES / 1024} KB`);
  const unknown = Object.keys(def).filter((k) => !DEF_KEYS.has(k));
  if (unknown.length) fail('UNKNOWN_KEYS', `definition: unknown key(s): ${unknown.slice(0, 5).join(', ')}`);
  if (def.name != null) ident(def.name, 'trigger name');
  if (def.event != null) {
    const ev = String(def.event).toUpperCase();
    if (!EVENT_RE.test(ev) && !EVENT_WORDS.has(ev) && ev !== 'SCHEDULED') fail('INVALID_EVENT', 'definition.event must look like AFTER_INSERT');
  }
  if (def.events != null) {
    const list = Array.isArray(def.events) ? def.events : [def.events];
    if (!list.length || list.length > 4) fail('INVALID_EVENT', 'definition.events must list 1-4 of INSERT, UPDATE, DELETE, TRUNCATE');
    list.forEach((e: any) => { if (!EVENT_WORDS.has(String(e).toUpperCase())) fail('INVALID_EVENT', `unsupported event "${String(e).slice(0, 20)}"`); });
  }
  if (def.timing != null && !TIMINGS.has(String(def.timing).toUpperCase())) fail('INVALID_EVENT', 'definition.timing must be BEFORE, AFTER or INSTEAD OF');
  for (const k of ['execution', 'forEach', 'scope']) if (def[k] != null && !['row', 'statement'].includes(String(def[k]).toLowerCase())) fail('INVALID_EVENT', `definition.${k} must be row or statement`);
  if (def.condition != null) validateCondition(def.condition, 'condition');
  if (def.execute != null) validateExecute(def.execute, opts);
  if (def.action != null) validateAction(def.action, opts);
  for (const k of ['procedure', 'function']) if (def[k] != null) qualified(def[k], `definition.${k}`, opts);
  if (def.schedule != null) validateSchedule(def.schedule);
  if (def.autoDrop != null) {
    if (!isObj(def.autoDrop)) fail('INVALID_DEFINITION', 'autoDrop must be an object');
    validateCondition(def.autoDrop.when, 'autoDrop.when');
    if (def.autoDrop.message != null) str(def.autoDrop.message, 'autoDrop.message', 500);
  }
}

/** A trigger declared inside a manifest table: the table/schema come from the manifest (already confined). */
export function validateManifestTrigger(t: any, opts: TriggerValidationOptions = {}): void {
  if (!isObj(t)) fail('INVALID_TRIGGER', 'trigger must be an object');
  ident(t.name, 'trigger name');
  if (!t.action && !t.execute && !t.procedure && !t.function) fail('INVALID_TRIGGER', `trigger ${String(t.name).slice(0, 40)}: needs one of action, execute, procedure, or function`);
  validateTriggerDefinition(t, opts);
}

/**
 * Validates a control-plane create/update payload: names, tenant confinement of schema/table and the definition.
 * `__SYSTEM__` schema/table are accepted only for schedule-only (generic scheduler) triggers.
 */
export function validateTriggerPayload(payload: any, tenantId: string, opts: TriggerValidationOptions = {}): { schemaName: string; tableName: string; triggerName: string } {
  if (!isObj(payload)) return fail('INVALID_TRIGGER', 'payload must be an object');
  assertTenantId(tenantId);
  if (!payload.triggerName || !payload.definition) fail('INVALID_TRIGGER', 'triggerName and definition are required');
  const triggerName = ident(payload.triggerName, 'triggerName');
  const definition = payload.definition;
  validateTriggerDefinition(definition, { ...opts, tenantId });
  if (!definition?.execute?.type) fail('INVALID_TRIGGER', 'definition.execute.type is required');
  const hasScheduler = !!definition?.schedule?.type;
  if (!hasScheduler && !definition?.event) fail('INVALID_TRIGGER', 'definition.event is required for row-based triggers');

  const rawSchema = payload.schemaName ?? SYSTEM_PLACEHOLDER;
  const rawTable = payload.tableName ?? SYSTEM_PLACEHOLDER;
  const isSystem = rawSchema === SYSTEM_PLACEHOLDER && rawTable === SYSTEM_PLACEHOLDER;
  if (isSystem) {
    if (!hasScheduler) fail('INVALID_TRIGGER', 'schemaName and tableName are required for row-based triggers');
    return { schemaName: SYSTEM_PLACEHOLDER, tableName: SYSTEM_PLACEHOLDER, triggerName };
  }
  if (rawSchema === SYSTEM_PLACEHOLDER || rawTable === SYSTEM_PLACEHOLDER) fail('INVALID_TRIGGER', 'schemaName and tableName must both be set or both be omitted');
  const schemaName = ident(rawSchema, 'schemaName');
  const tableName = ident(rawTable, 'tableName');
  if (schemaName.length > 63) fail('INVALID_IDENTIFIER', 'schemaName too long');
  if (!belongsToTenant(schemaName, tenantId)) fail('CROSS_TENANT', `schema "${schemaName}" is outside your workspace (expected tenant_${tenantId} or tenant_${tenantId}_<schema>)`);
  return { schemaName, tableName, triggerName };
}
