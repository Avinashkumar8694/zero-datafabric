import { pool } from '../../config/database';

/**
 * ConstraintService — the fabric's engine-agnostic CONSTRAINT enforcement.
 *
 * Postgres enforces NOT NULL / UNIQUE / CHECK / ENUM / FOREIGN KEY natively at
 * write time. Document/search engines (MongoDB, Elasticsearch) do not (Mongo can
 * back UNIQUE with an index, but has no CHECK / enum / FK / NOT-NULL semantics).
 * Following the fabric's compensation model, constraints are stored
 * engine-agnostically and VALIDATED IN-FABRIC before a write is dispatched to a
 * non-SQL engine:
 *
 *   • push-down          — Postgres writes skip fabric validation (native enforces)
 *   • compensate-in-fabric — Mongo/ES writes are validated here first
 *   • reject-if-impossible — a constraint the fabric can't model (e.g. EXCLUDE …
 *                            USING GIST) is surfaced as an explicit, non-silent skip
 *
 * A constraint spec is deliberately simple + declarative so it maps to any engine
 * and is easy to author from a manifest or the API:
 *   columns : [( name, notNull?, unique?, enum?: string[], fk?: (...) )]
 *   checks  : [( name, column, op: 'REGEX'|'GT'|'GTE'|'LT'|'LTE'|'EQ'|'NEQ'|'IN'|'LEN_LTE'|'NOT_NULL', value? )]
 * Existing Postgres-style `constraints[]` (CHECK expressions) are best-effort
 * parsed into this structured form (regex `~`, simple comparisons) so current
 * manifests keep working; anything unparseable is kept for Postgres only.
 */

export interface ConstraintColumn {
  name: string;
  notNull?: boolean;
  unique?: boolean;
  enum?: string[];
  fk?: { source?: string; schema?: string; table: string; column: string };
}
export type CheckOp = 'REGEX' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'EQ' | 'NEQ' | 'IN' | 'LEN_LTE' | 'NOT_NULL';
export interface CheckRule { name: string; column: string; op: CheckOp; value?: any }
export interface ConstraintSpec { columns: ConstraintColumn[]; checks: CheckRule[] }

export interface Violation { constraint: string; column?: string; rule: string; detail: string }

/** Async lookups the caller supplies so the fabric can verify UNIQUE / FK at the source. */
export interface ConstraintLookups {
  /** count existing docs where column === value (excluding the row being updated). */
  countWhere?: (column: string, value: any) => Promise<number>;
  /** does a row exist in the FK target where refColumn === value? */
  fkExists?: (fk: NonNullable<ConstraintColumn['fk']>, value: any) => Promise<boolean>;
}

/**
 * Engine-agnostic constraint store + validator (see file-level overview for
 * the push-down/compensate-in-fabric/reject-if-impossible model). All methods
 * are static; the class is never instantiated.
 */
export class ConstraintService {
  private static ready = false;

  /** Lazily create the `fabric_system.fabric_constraints` table (idempotent, runs at most once per process). */
  static async ensureTable(): Promise<void> {
    if (this.ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.fabric_constraints (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   text NOT NULL,
        schema_name text NOT NULL,
        table_name  text NOT NULL,
        spec        jsonb NOT NULL DEFAULT '{}'::jsonb,
        source      text NOT NULL DEFAULT 'API',
        updated_at  timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, schema_name, table_name)
      )`);
    this.ready = true;
  }

  /**
   * Create or replace (upsert, by tenant + schema + table) the constraint spec for a table.
   * @param tenantId tenant identifier.
   * @param schema physical schema name.
   * @param table physical table name.
   * @param spec the constraint spec (columns + checks) to store.
   * @param source provenance label (e.g. `'API'`, `'MANIFEST'`); default `'API'`.
   * @returns the stored row: `(id, schema, table, spec, source)`.
   */
  static async upsert(tenantId: string, schema: string, table: string, spec: ConstraintSpec, source = 'API'): Promise<any> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.fabric_constraints (tenant_id, schema_name, table_name, spec, source, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,NOW())
       ON CONFLICT (tenant_id, schema_name, table_name)
       DO UPDATE SET spec = EXCLUDED.spec, source = EXCLUDED.source, updated_at = NOW()
       RETURNING id, schema_name AS schema, table_name AS "table", spec, source`,
      [tenantId, schema, table, JSON.stringify(spec), source]
    );
    return rows[0];
  }

  /**
   * List a tenant's stored constraint specs, most recently updated first.
   * @param tenantId tenant identifier.
   * @returns all stored constraint specs across every table.
   */
  static async list(tenantId: string): Promise<any[]> {
    await this.ensureTable();
    const { rows } = await pool.query(
      `SELECT id, schema_name AS schema, table_name AS "table", spec, source, updated_at AS "updatedAt"
       FROM fabric_system.fabric_constraints WHERE tenant_id = $1 ORDER BY updated_at DESC`, [tenantId]);
    return rows;
  }

  /**
   * Look up the constraint spec for a physical table, if any is stored and non-empty.
   * Called before a write to a non-SQL engine so it can be validated in-fabric
   * (see `QueryEngineService.mutate`'s CONSTRAINT COMPENSATION step).
   * @param tenantId tenant identifier.
   * @param physicalSchema physical schema name.
   * @param table physical table name.
   * @returns the stored spec, or `null` if none is stored or it has no columns/checks.
   */
  static async resolve(tenantId: string, physicalSchema: string, table: string): Promise<ConstraintSpec | null> {
    await this.ensureTable();
    const result = await pool.query(
      `SELECT spec FROM fabric_system.fabric_constraints WHERE tenant_id=$1 AND schema_name=$2 AND table_name=$3`,
      [tenantId, physicalSchema, table]);
    const spec = result?.rows?.[0]?.spec;
    return spec && (spec.columns?.length || spec.checks?.length) ? spec : null;
  }

  /**
   * Build an engine-agnostic constraint spec from a manifest TABLE resource
   * (column flags + enum refs + `constraints[]` CHECK expressions + relationship FKs).
   * Column-level constraints (`notNull`/`unique`/`enum`/`fk`) are derived from
   * each column's `nullable`/`primaryKey`/`unique`/`type`/`ref` flags plus any
   * matching FK from `fks`. Table-level `CHECK` constraints are best-effort
   * parsed via (@link parseCheckExpression); anything else (e.g. `EXCLUDE ...
   * USING GIST`) is a Postgres-only construct and is deliberately left out
   * (reject-if-impossible — not modelled in-fabric). Structured `checks[]`
   * authored directly on the resource are passed through unchanged.
   * @param resource the manifest TABLE resource (`columns`, `constraints`, optional `checks`).
   * @param enums a `(enumRef: allowedValues[])` map resolved from the manifest's ENUM definitions.
   * @param fks relationship-derived foreign keys `(column, ...fk)` for this table, if any.
   * @returns the engine-agnostic `(columns, checks)` spec.
   */
  static specFromManifestTable(resource: any, enums: Record<string, string[]>, fks: any[] = []): ConstraintSpec {
    const columns: ConstraintColumn[] = [];
    for (const c of resource.columns || []) {
      const col: ConstraintColumn = { name: c.name };
      if (c.nullable === false || c.primaryKey) col.notNull = true;
      if (c.unique || c.primaryKey) col.unique = true;
      if ((c.type === 'ENUM' || String(c.type).toUpperCase() === 'ENUM') && c.ref && enums[c.ref]) col.enum = enums[c.ref]!;
      const fk = fks.find((f) => f.column === c.name);
      if (fk) col.fk = fk;
      if (col.notNull || col.unique || col.enum || col.fk) columns.push(col);
    }
    const checks: CheckRule[] = [];
    for (const con of resource.constraints || []) {
      if (con.type === 'CHECK' && con.expression) {
        const parsed = this.parseCheckExpression(con.name, con.expression);
        if (parsed) checks.push(parsed);
      }
      // EXCLUDE / GIST etc. are Postgres-only → reject-if-impossible (not modelled in-fabric).
    }
    // Structured checks authored directly on the resource (engine-agnostic, preferred).
    for (const c of resource.checks || []) checks.push(c);
    return { columns, checks };
  }

  /**
   * Best-effort parse of a simple Postgres CHECK into a structured rule.
   * Recognizes a regex match (`col ~ '...'` / `col ~* '...'`) and a numeric
   * comparison (`col >|>=|<|<=|=|<> n`). Anything more complex is a
   * Postgres-only expression left to native enforcement there.
   * @param name the CHECK constraint's name.
   * @param expr the raw CHECK expression text.
   * @returns the structured (@link CheckRule), or `null` if the expression doesn't match a supported pattern.
   */
  static parseCheckExpression(name: string, expr: string): CheckRule | null {
    const s = String(expr).trim();
    let m: RegExpMatchArray | null;
    // col ~ 'regex'  /  col ~* 'regex'
    if ((m = s.match(/^([a-zA-Z_][\w]*)\s*~\*?\s*'(.+)'$/))) return { name, column: m[1]!, op: 'REGEX', value: m[2] };
    // col >= n / > / <= / < / = / <>
    if ((m = s.match(/^([a-zA-Z_][\w]*)\s*(>=|<=|<>|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/))) {
      const opMap: Record<string, CheckOp> = { '>': 'GT', '>=': 'GTE', '<': 'LT', '<=': 'LTE', '=': 'EQ', '<>': 'NEQ', '!=': 'NEQ' };
      return { name, column: m[1]!, op: opMap[m[2]!]!, value: Number(m[3]) };
    }
    return null; // Postgres-only expression; leave to native enforcement.
  }

  /**
   * Evaluate a single check rule against a value. Returns true when SATISFIED.
   * `null`/`undefined` values pass every rule except `NOT_NULL`, matching SQL's
   * CHECK semantics (a NULL value never fails a CHECK constraint).
   * @param rule the check rule to evaluate.
   * @param value the value to test.
   * @returns whether `value` satisfies `rule`.
   */
  private static evalCheck(rule: CheckRule, value: any): boolean {
    if (value === null || value === undefined) return rule.op !== 'NOT_NULL'; // null passes value-checks (SQL semantics); NOT_NULL fails
    switch (rule.op) {
      case 'REGEX': try { return new RegExp(rule.value).test(String(value)); } catch { return true; }
      case 'GT': return Number(value) > Number(rule.value);
      case 'GTE': return Number(value) >= Number(rule.value);
      case 'LT': return Number(value) < Number(rule.value);
      case 'LTE': return Number(value) <= Number(rule.value);
      case 'EQ': return value === rule.value;
      case 'NEQ': return value !== rule.value;
      case 'IN': return Array.isArray(rule.value) && rule.value.includes(value);
      case 'LEN_LTE': return String(value).length <= Number(rule.value);
      case 'NOT_NULL': return true;
      default: return true;
    }
  }

  /**
   * Validate rows against a spec for a non-SQL-engine write. Returns all
   * violations found (empty = OK). NOT NULL / ENUM / CHECK are synchronous;
   * UNIQUE / FK use the supplied lookups (skipped if not provided).
   * On `create`, NOT NULL is enforced unconditionally; on `update`, NOT NULL
   * and CHECK are only evaluated for columns actually present in the row
   * (partial updates shouldn't be penalized for columns they don't touch).
   * @param rows the row(s) being written.
   * @param spec the table's constraint spec (see (@link resolve)/(@link specFromManifestTable)).
   * @param op whether this is a create (insert) or update, affecting NOT NULL/CHECK evaluation.
   * @param lookups async source lookups for UNIQUE/FK checks; omitting either skips that check kind.
   * @returns every violation found across all rows (empty array means the write may proceed).
   */
  static async validate(rows: any[], spec: ConstraintSpec, op: 'create' | 'update', lookups: ConstraintLookups = {}): Promise<Violation[]> {
    const violations: Violation[] = [];
    for (const row of rows) {
      for (const col of spec.columns || []) {
        const present = row && Object.prototype.hasOwnProperty.call(row, col.name);
        const val = row?.[col.name];
        // NOT NULL — enforced on create always; on update only when the column is being set.
        if (col.notNull && (op === 'create' ? (val === null || val === undefined) : (present && (val === null || val === undefined)))) {
          violations.push({ constraint: `${col.name}_not_null`, column: col.name, rule: 'NOT_NULL', detail: `column "${col.name}" must not be null` });
        }
        // ENUM
        if (col.enum && present && val !== null && val !== undefined && !col.enum.includes(val)) {
          violations.push({ constraint: `${col.name}_enum`, column: col.name, rule: 'ENUM', detail: `"${val}" not in {${col.enum.join(', ')}}` });
        }
        // UNIQUE (needs a source lookup)
        if (col.unique && present && val !== null && val !== undefined && lookups.countWhere) {
          const n = await lookups.countWhere(col.name, val);
          if (n > 0) violations.push({ constraint: `${col.name}_unique`, column: col.name, rule: 'UNIQUE', detail: `duplicate value "${val}" for unique column "${col.name}"` });
        }
        // FOREIGN KEY (needs a source lookup)
        if (col.fk && present && val !== null && val !== undefined && lookups.fkExists) {
          const ok = await lookups.fkExists(col.fk, val);
          if (!ok) violations.push({ constraint: `${col.name}_fk`, column: col.name, rule: 'FOREIGN_KEY', detail: `"${val}" not present in ${col.fk.table}.${col.fk.column}` });
        }
      }
      for (const chk of spec.checks || []) {
        const present = row && Object.prototype.hasOwnProperty.call(row, chk.column);
        if (op === 'update' && !present) continue; // only validate columns being written on update
        if (!this.evalCheck(chk, row?.[chk.column])) {
          violations.push({ constraint: chk.name, column: chk.column, rule: `CHECK(${chk.op})`, detail: `value "${row?.[chk.column]}" fails check "${chk.name}"` });
        }
      }
    }
    return violations;
  }
}
