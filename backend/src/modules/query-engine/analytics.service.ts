import { pool } from '../../config/database';
import { QueryEngineService } from './query-engine.service';

/**
 * SavedAnalyticsService — persist reusable, parameterized analytics and run them
 * on demand or via API.
 *
 * An analytic captures a query (AST-mode `config`, or a raw `sql` string) plus a
 * set of declared **variables**. The query body references a variable with a
 * `{{name}}` placeholder. At run time the caller supplies values (from the UI or
 * an API call) which are bound into the query:
 *
 *   • AST mode  — `{{name}}` tokens are replaced with the TYPED value in a deep
 *                 clone of the config; the value then flows through the normal
 *                 parameterized pushdown path (injection-safe).
 *   • SQL mode  — `{{name}}` tokens are replaced with a safely-escaped SQL literal
 *                 (numbers/booleans bare, strings single-quote-escaped).
 *
 * This is the fabric's "saved query / scheduled report" primitive: define once,
 * trigger many times with different inputs, from the UI or `POST /:id/run`.
 */

export type AnalyticVarType = 'string' | 'number' | 'boolean';
export interface AnalyticVariable {
  name: string;
  type: AnalyticVarType;
  label?: string;
  required?: boolean;
  default?: any;
}
export interface SavedAnalytic {
  name: string;
  description?: string;
  mode: 'AST' | 'SQL';
  /** AST mode: the full queryConfig ({ type:'SELECT', schema, query, limit }). */
  config?: any;
  /** SQL mode: a raw SQL string (may target a source via `source`). */
  sql?: string;
  source?: string;
  variables?: AnalyticVariable[];
}

const VAR_TOKEN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Persists reusable, parameterized analytics (AST or SQL, with `{{variable}}`
 * bindings) and runs/triggers them on demand with supplied variable values.
 * @class
 * @hideconstructor
 */
export class SavedAnalyticsService {
  private static ready = false;

  /**
   * Lazily create the `fabric_system.saved_analytics` table (idempotent, runs
   * at most once per process), and backfill the `run_count`/`last_run_at`
   * usage-tracking columns onto any pre-existing table.
   */
  static async ensureTable(): Promise<void> {
    if (this.ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.saved_analytics (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   text NOT NULL,
        name        text NOT NULL,
        description text,
        mode        text NOT NULL DEFAULT 'AST',
        definition  jsonb NOT NULL DEFAULT '{}'::jsonb,
        variables   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by  text,
        created_at  timestamptz NOT NULL DEFAULT NOW(),
        updated_at  timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )`);
    // Usage counters (added for existing tables too) drive the "top executed" list.
    await pool.query('ALTER TABLE fabric_system.saved_analytics ADD COLUMN IF NOT EXISTS run_count integer NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE fabric_system.saved_analytics ADD COLUMN IF NOT EXISTS last_run_at timestamptz');
    this.ready = true;
  }

  /**
   * Create or update (upsert, by tenant + name) a saved analytic.
   * @param tenantId tenant identifier.
   * @param username the creating/updating user, recorded as `created_by`.
   * @param a the analytic definition (see {@link SavedAnalytic}).
   * @returns the stored row: `{ id, name, description, mode, definition, variables, createdAt }`.
   * @throws if AST mode is missing `config`, or SQL mode is missing `sql`.
   */
  static async create(tenantId: string, username: string, a: SavedAnalytic): Promise<any> {
    await this.ensureTable();
    const mode = a.mode === 'SQL' ? 'SQL' : 'AST';
    if (mode === 'AST' && !a.config) throw new Error('AST analytic requires a "config"');
    if (mode === 'SQL' && !a.sql) throw new Error('SQL analytic requires a "sql" string');
    const definition = mode === 'AST' ? { config: a.config } : { sql: a.sql, source: a.source || null };
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.saved_analytics (tenant_id, name, description, mode, definition, variables, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,NOW())
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET description=EXCLUDED.description, mode=EXCLUDED.mode, definition=EXCLUDED.definition,
                     variables=EXCLUDED.variables, updated_at=NOW()
       RETURNING id, name, description, mode, definition, variables, created_at AS "createdAt"`,
      [tenantId, a.name, a.description || null, mode, JSON.stringify(definition), JSON.stringify(a.variables || []), username]
    );
    return rows[0];
  }

  /**
   * List a tenant's saved analytics, most recently updated first.
   * @param tenantId tenant identifier.
   * @returns all stored analytics with their definitions, variables, and usage counters.
   */
  static async list(tenantId: string): Promise<any[]> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, description, mode, definition, variables, run_count AS "runCount",
              last_run_at AS "lastRunAt", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM fabric_system.saved_analytics WHERE tenant_id=$1 ORDER BY updated_at DESC`, [tenantId]);
    return rows;
  }

  /** Top analytics by execution count (most-run first), for dashboard quick-run. */
  static async top(tenantId: string, limit = 8): Promise<any[]> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, description, mode, variables, run_count AS "runCount", last_run_at AS "lastRunAt"
       FROM fabric_system.saved_analytics WHERE tenant_id=$1
       ORDER BY run_count DESC, last_run_at DESC NULLS LAST, updated_at DESC
       LIMIT $2`, [tenantId, Math.min(Math.max(Number(limit) || 8, 1), 24)]);
    return rows;
  }

  /**
   * Fetch one saved analytic's full definition by id.
   * @param tenantId tenant identifier.
   * @param id the analytic's id.
   * @returns the stored row, or `null` if not found.
   */
  static async get(tenantId: string, id: string): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, name, description, mode, definition, variables, created_at AS "createdAt"
       FROM fabric_system.saved_analytics WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] || null;
  }

  /**
   * Delete a saved analytic.
   * @param tenantId tenant identifier.
   * @param id the analytic's id.
   * @returns true if a row was deleted, false if no matching row existed.
   */
  static async remove(tenantId: string, id: string): Promise<boolean> {
    await this.ensureTable();
    const { rowCount } = await pool.query('DELETE FROM fabric_system.saved_analytics WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    return (rowCount || 0) > 0;
  }

  /**
   * Resolve declared variables against supplied values (applying defaults + required checks).
   * @param variables the analytic's declared variable schema.
   * @param provided caller-supplied `{ name: value }` values.
   * @returns a `{ name: typedValue }` map with defaults applied and values coerced to their declared type.
   * @throws if a required variable has no provided value and no default.
   */
  static resolveValues(variables: AnalyticVariable[], provided: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const v of variables || []) {
      let val = provided?.[v.name];
      if (val === undefined || val === '') val = v.default;
      if ((val === undefined || val === null) && v.required) throw new Error(`missing required variable "${v.name}"`);
      if (val !== undefined && val !== null) {
        if (v.type === 'number') val = Number(val);
        else if (v.type === 'boolean') val = (val === true || val === 'true' || val === 1);
        else val = String(val);
      }
      out[v.name] = val;
    }
    return out;
  }

  /**
   * Deep-replace `{{name}}` tokens in an AST config with typed values.
   * A string that is ENTIRELY a `{{name}}` token is replaced with the typed
   * value itself (so a numeric/boolean variable stays numeric/boolean through
   * the normal parameterized pushdown path); a token embedded within a larger
   * string is replaced with its stringified form. Recurses through arrays and
   * plain objects, returning a deep clone.
   * @param node the AST node (or subtree) to bind; a deep clone is returned.
   * @param values resolved variable values (see {@link resolveValues}).
   * @returns a new AST node/subtree with every token replaced.
   */
  static bindAst(node: any, values: Record<string, any>): any {
    if (typeof node === 'string') {
      const m = node.match(/^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/);
      const key = m && m[1];
      if (key && key in values) return values[key]; // whole-string token → typed value
      return node.replace(VAR_TOKEN, (_s, n) => (n in values ? String(values[n]) : _s)); // embedded → string
    }
    if (Array.isArray(node)) return node.map((x) => this.bindAst(x, values));
    if (node && typeof node === 'object') {
      const o: any = {};
      for (const k of Object.keys(node)) o[k] = this.bindAst(node[k], values);
      return o;
    }
    return node;
  }

  /**
   * Bind `{{name}}` tokens in a SQL string with safely-escaped literals.
   * Numbers/booleans are inlined bare; strings are single-quote-escaped;
   * `null`/`undefined` become SQL `NULL` — this is the injection-safe
   * substitution used for SQL-mode analytics (AST mode instead flows values
   * through the normal parameterized pushdown path via {@link bindAst}).
   * @param sql the raw SQL text containing `{{name}}` tokens.
   * @param values resolved variable values (see {@link resolveValues}).
   * @returns the SQL text with every recognized token replaced by its literal; unrecognized tokens are left as-is.
   */
  static bindSql(sql: string, values: Record<string, any>): string {
    return String(sql).replace(VAR_TOKEN, (_s, n) => {
      if (!(n in values)) return _s;
      const v = values[n];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return `'${String(v).replace(/'/g, "''")}'`;
    });
  }

  /**
   * Run a saved analytic with the supplied variable values. Returns the standard
   * query envelope ({ data, rowCount, plan, warnings }) plus the bound variables.
   * SQL-mode analytics targeting a named external source run through
   * {@link QueryEngineService.executeSqlOnSource}; SQL-mode analytics with no
   * source (or the hub) run directly via `queryWithContext`; AST-mode
   * analytics bind their config and run through the full
   * {@link QueryEngineService.executeQuery} pipeline. Usage counters
   * (`run_count`/`last_run_at`) are bumped fire-and-forget after the result is
   * ready, so a logging failure never affects the query result.
   * @param tenantId tenant identifier.
   * @param id the analytic's id.
   * @param provided caller-supplied variable values.
   * @param session caller session, passed through to AST-mode execution / the hub SQL context.
   * @returns `{ analytic: { id, name, mode }, boundVariables, ...queryResult }`.
   * @throws if the analytic doesn't exist, or a required variable is missing (see {@link resolveValues}).
   */
  static async run(tenantId: string, id: string, provided: Record<string, any>, session?: any): Promise<any> {
    const a = await this.get(tenantId, id);
    if (!a) throw new Error('analytic not found');
    const values = this.resolveValues(a.variables || [], provided || {});
    let result: any;
    if (a.mode === 'SQL') {
      const sql = this.bindSql(a.definition?.sql || '', values);
      const src = a.definition?.source;
      if (src && src !== 'Fabric_Hub_Postgres') {
        result = await QueryEngineService.executeSqlOnSource(tenantId, src, sql, [], undefined);
      } else {
        const { queryWithContext } = await import('../../config/database');
        const r = await queryWithContext(sql, [], { tenantId, username: session?.username || 'system' });
        result = { data: r.rows, rowCount: r.rowCount ?? (r.rows?.length || 0), plan: { strategy: 'SAVED_SQL' } };
      }
    } else {
      const config = this.bindAst(a.definition?.config || {}, values);
      result = await QueryEngineService.executeQuery(tenantId, config, session);
    }
    // Bump usage counters so the dashboard can surface top-executed analytics.
    pool.query('UPDATE fabric_system.saved_analytics SET run_count = run_count + 1, last_run_at = NOW() WHERE tenant_id=$1 AND id=$2', [tenantId, id]).catch(() => {});
    return { analytic: { id: a.id, name: a.name, mode: a.mode }, boundVariables: values, ...result };
  }
}
