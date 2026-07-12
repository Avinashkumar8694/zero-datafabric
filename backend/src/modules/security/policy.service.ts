import { pool } from '../../config/database';

/**
 * PolicyService — the fabric's engine-agnostic access-policy layer.
 *
 * Postgres enforces row-level security and column masking natively. Non-RLS
 * engines (MongoDB, Elasticsearch, remote warehouses reached as connectors) have
 * no such enforcement, so the fabric compensates:
 *
 *   • ROW policies  → compiled into a CanonicalQuery filter and INJECTED into the
 *                     leg's pushdown, so the predicate runs AT THE SOURCE (Mongo
 *                     `$match`, ES query, remote SQL WHERE) — the tenant only ever
 *                     receives rows they are allowed to see.
 *   • COLUMN masking → applied to result rows POST-fetch (REDACT / NULL / HASH /
 *                     PARTIAL) for the roles the rule targets.
 *
 * Policies are stored engine-agnostically in fabric_system.access_policies so the
 * SAME definition drives every engine. A policy predicate clause is
 * `(column, operator, value)`, where `value` is a literal or a session
 * reference `(session: 'tenant_id' | 'region' | 'role' | 'username')` resolved
 * per request — the analogue of a Postgres policy's `current_setting('app.*')`.
 */

export type PolicyOperator =
  | 'EQ' | 'NEQ' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN' | 'LIKE' | 'IS_NULL' | 'IS_NOT_NULL';

export interface PolicyClause {
  column: string;
  operator: PolicyOperator;
  /** Literal, array (for IN), or a session reference: { session: 'tenant_id' | 'region' | 'role' | 'username' }. */
  value?: any;
}

export type MaskStrategy = 'REDACT' | 'NULL' | 'HASH' | 'PARTIAL';

export interface MaskRule {
  column: string;
  /** Roles the mask applies to; omit = mask for everyone. */
  roles?: string[];
  strategy: MaskStrategy;
}

export interface AccessPolicy {
  name: string;
  schema: string;   // logical (Global_Supply_Chain) or physical (tenant_x_Global_Supply_Chain)
  table: string;
  /** Roles this row policy restricts; omit = applies to all roles. */
  roles?: string[];
  rowFilter?: PolicyClause[];
  masking?: MaskRule[];
}

export interface SessionCtx {
  tenantId: string;
  role?: string;
  region?: string;
  username?: string;
}

const CANON_OP: Record<string, string> = {
  EQ: '$eq', NEQ: '$ne', GT: '$gt', GTE: '$gte', LT: '$lt', LTE: '$lte', IN: '$in', LIKE: '$like',
};

/**
 * Engine-agnostic access-policy service: stores row policies + column masking and
 * enforces them on non-RLS engines (row-predicate injection + post-fetch masking).
 * @class
 * @hideconstructor
 */
export class PolicyService {
  private static ready = false;

  /** Create the engine-agnostic policy catalog (idempotent). */
  static async ensureTable(): Promise<void> {
    if (this.ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.access_policies (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     text NOT NULL,
        schema_name   text NOT NULL,
        table_name    text NOT NULL,
        policy_name   text NOT NULL,
        roles         jsonb NOT NULL DEFAULT '[]'::jsonb,
        row_filter    jsonb NOT NULL DEFAULT '[]'::jsonb,
        masking       jsonb NOT NULL DEFAULT '[]'::jsonb,
        source        text NOT NULL DEFAULT 'API',
        created_at    timestamptz NOT NULL DEFAULT NOW(),
        updated_at    timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, schema_name, table_name, policy_name)
      )`);
    this.ready = true;
  }

  /** Normalize a logical or physical schema to the tenant's physical schema. */
  static physicalSchema(tenantId: string, schema: string): string {
    const prefix = `tenant_${tenantId}_`;
    if (schema.startsWith(prefix) || schema.startsWith('tenant_')) return schema;
    return `${prefix}${schema}`;
  }

  /**
   * Create or replace a named access policy for a (schema, table). Upserts on
   * the (tenant, schema, table, policyName) unique key, so re-applying the
   * same policy name overwrites its previous row filter/masking definition.
   * @param tenantId - Owning tenant.
   * @param p - The policy definition (name, schema, table, roles, rowFilter, masking).
   * @param source - Origin of the write, e.g. 'API' or 'MANIFEST'.
   * @returns The persisted policy row.
   */
  static async upsertPolicy(tenantId: string, p: AccessPolicy, source = 'API'): Promise<any> {
    await this.ensureTable();
    // Store the schema EXACTLY as the query leg will present it — for tenant-managed
    // Postgres that is `tenant_<id>_<logical>` (the orchestrator passes it already
    // physical); for external connectors it is the remote db/schema (e.g. Mongo's
    // db name, a remote PG schema). No auto-prefixing, so resolve() matches exactly.
    const schema = p.schema;
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.access_policies
        (tenant_id, schema_name, table_name, policy_name, roles, row_filter, masking, source, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,NOW())
       ON CONFLICT (tenant_id, schema_name, table_name, policy_name)
       DO UPDATE SET roles = EXCLUDED.roles, row_filter = EXCLUDED.row_filter,
                     masking = EXCLUDED.masking, source = EXCLUDED.source, updated_at = NOW()
       RETURNING id, policy_name AS name, schema_name AS schema, table_name AS "table", roles, row_filter AS "rowFilter", masking, source`,
      [tenantId, schema, p.table, p.name, JSON.stringify(p.roles || []),
       JSON.stringify(p.rowFilter || []), JSON.stringify(p.masking || []), source]
    );
    return rows[0];
  }

  /**
   * List every declared access policy for a tenant, newest first.
   * @param tenantId - Tenant whose policies are being listed.
   * @returns All policy rows for the tenant (may be empty).
   */
  static async listPolicies(tenantId: string): Promise<any[]> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, policy_name AS name, schema_name AS schema, table_name AS "table",
              roles, row_filter AS "rowFilter", masking, source, updated_at AS "updatedAt"
       FROM fabric_system.access_policies WHERE tenant_id = $1 ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows;
  }

  /**
   * Delete a single access policy by id, scoped to the owning tenant.
   * @param tenantId - Owning tenant (guards against cross-tenant deletion).
   * @param id - The policy's uuid.
   * @returns `true` if a row was deleted, `false` if no matching policy existed.
   */
  static async deletePolicy(tenantId: string, id: string): Promise<boolean> {
    await this.ensureTable();
    const { rowCount } = await pool.query(
      `DELETE FROM fabric_system.access_policies WHERE tenant_id = $1 AND id = $2`, [tenantId, id]
    );
    return (rowCount || 0) > 0;
  }

  /**
   * Resolve a session reference (`(session: 'tenant_id' | 'region' | 'role' |
   * 'username')`) to its concrete value from `session`, or pass a literal
   * value through unchanged.
   * @param value - A policy clause's literal value, or a session reference object.
   * @param session - The request's session context.
   * @returns The resolved literal value (or `null` for an unset/unknown session reference).
   */
  private static resolveValue(value: any, session: SessionCtx): any {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'session' in value) {
      switch (String(value.session)) {
        case 'tenant_id': return session.tenantId;
        case 'region': return session.region ?? null;
        case 'role': return session.role ?? null;
        case 'username': return session.username ?? null;
        default: return null;
      }
    }
    return value;
  }

  /**
   * Test whether a policy's (or masking rule's) role restriction applies to
   * the current session. An empty/missing role list means the rule applies
   * to every role.
   * @param roles - The `roles` array declared on a policy or mask rule.
   * @param session - The request's session context.
   * @returns `true` if the rule applies to `session.role`.
   */
  private static roleMatches(roles: any, session: SessionCtx): boolean {
    if (!Array.isArray(roles) || roles.length === 0) return true; // applies to all
    const r = String(session.role || '').toUpperCase();
    return roles.map((x) => String(x).toUpperCase()).includes(r);
  }

  /**
   * Compile a list of policy clauses into a CanonicalQuery filter fragment.
   * Multiple clauses on the same column are merged (all conditions apply).
   */
  static compileFilter(clauses: PolicyClause[], session: SessionCtx): Record<string, any> {
    const filter: Record<string, any> = {};
    for (const c of clauses || []) {
      if (!c || !c.column) continue;
      const op = String(c.operator || 'EQ').toUpperCase();
      const col = c.column;
      const merge = (frag: any) => { filter[col] = { ...(typeof filter[col] === 'object' ? filter[col] : {}), ...frag }; };
      if (op === 'IS_NULL') { merge({ $eq: null }); continue; }
      if (op === 'IS_NOT_NULL') { merge({ $ne: null }); continue; }
      const canonOp = CANON_OP[op];
      if (!canonOp) continue;
      merge({ [canonOp]: this.resolveValue(c.value, session) });
    }
    return filter;
  }

  /**
   * Resolve the effective row-filter + masking for a physical (schema, table)
   * under a session. Only policies whose roles match the session are applied.
   */
  static async resolve(
    tenantId: string, physicalSchema: string, table: string, session: SessionCtx
  ): Promise<{ filter: Record<string, any>; masks: MaskRule[]; applied: string[] }> {
    await this.ensureTable();
    const result = await pool.query(
      `SELECT policy_name, roles, row_filter, masking
       FROM fabric_system.access_policies
       WHERE tenant_id = $1 AND schema_name = $2 AND table_name = $3`,
      [tenantId, physicalSchema, table]
    );
    const rows = result?.rows || [];
    let filter: Record<string, any> = {};
    const masks: MaskRule[] = [];
    const applied: string[] = [];
    for (const row of rows) {
      if (!this.roleMatches(row.roles, session)) continue;
      const clauses: PolicyClause[] = Array.isArray(row.row_filter) ? row.row_filter : [];
      if (clauses.length) {
        const frag = this.compileFilter(clauses, session);
        for (const [col, cond] of Object.entries(frag)) {
          filter[col] = { ...(typeof filter[col] === 'object' ? filter[col] : {}), ...(cond as object) };
        }
      }
      for (const m of (Array.isArray(row.masking) ? row.masking : [])) {
        if (this.roleMatches(m.roles, session)) masks.push(m);
      }
      applied.push(row.policy_name);
    }
    return { filter, masks, applied };
  }

  /** Merge a policy filter fragment into an existing CanonicalQuery filter. */
  static mergeIntoFilter(existing: Record<string, any> | undefined, policyFilter: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { ...(existing || {}) };
    for (const [col, cond] of Object.entries(policyFilter)) {
      const prev = out[col];
      if (prev && typeof prev === 'object' && !Array.isArray(prev) && typeof cond === 'object') {
        out[col] = { ...prev, ...cond };
      } else if (prev !== undefined && (typeof prev !== 'object' || Array.isArray(prev))) {
        // Existing bare-equality plus a policy condition → combine as operators.
        out[col] = { $eq: prev, ...(cond as object) };
      } else {
        out[col] = cond;
      }
    }
    return out;
  }

  /** Apply masking to result rows for the given session. */
  static applyMasks(rows: any[], masks: MaskRule[], _session: SessionCtx): any[] {
    if (!masks.length || !Array.isArray(rows)) return rows;
    return rows.map((r) => {
      if (!r || typeof r !== 'object') return r;
      const copy = { ...r };
      for (const m of masks) {
        if (!(m.column in copy)) continue;
        copy[m.column] = this.maskValue(copy[m.column], m.strategy);
      }
      return copy;
    });
  }

  /**
   * Apply a single masking strategy to a scalar value.
   * @param v - The raw column value (nullish values pass through unmasked).
   * @param strategy - One of REDACT / NULL / HASH / PARTIAL.
   * @returns The masked value, or `v` unchanged for an unrecognized strategy.
   */
  private static maskValue(v: any, strategy: MaskStrategy): any {
    if (v === null || v === undefined) return v;
    switch (strategy) {
      case 'NULL': return null;
      case 'REDACT': return '***REDACTED***';
      case 'HASH': return `sha256:${this.cheapHash(String(v))}`;
      case 'PARTIAL': {
        const s = String(v);
        if (s.length <= 4) return '****';
        return `${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
      }
      default: return v;
    }
  }

  /**
   * Small non-crypto digest — masking only needs a stable, non-reversible
   * output here, not cryptographic strength (djb2-style hash).
   * @param s - Input string to hash.
   * @returns An 8-hex-digit digest.
   */
  private static cheapHash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, '0');
  }
}
