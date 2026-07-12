/**
 * TriggerActionCompiler — turns a DECLARATIVE trigger definition into native
 * Postgres DDL, so authors never hand-write plpgsql function bodies.
 *
 * A manifest/registry trigger may declare its behaviour in three ways:
 *
 *   1. procedure  — `{ procedure: 'audit_log_fn' }`
 *                   EXECUTE an existing trigger function (advanced escape hatch).
 *
 *   2. execute    — `{ execute: { type: 'AUDIT' | 'WEBHOOK' | 'EMAIL' |
 *                                        'TELEGRAM' | 'FUNCTION' | 'EXCEPTION' } }`
 *                   The same declarative action model the API/UI triggers use.
 *
 *   3. action     — a mini SQL/AST action DSL, e.g.
 *                   `{ action: { type: 'INSERT', into: 'audit',
 *                                values: { ref: 'NEW.id', op: 'TG_OP', at: 'NOW()' } } }`
 *                   `{ action: { type: 'RAISE', when: {left,operator,right}, message } }`
 *                   `{ action: { type: 'PERFORM', function: 'fn' } }`
 *                   `{ action: { sql: 'INSERT INTO audit(...) VALUES (NEW.id, TG_OP)' } }`
 *
 * All value expressions are compiled through a small whitelist (NEW./OLD. column
 * refs, TG_OP/TG_TABLE_NAME/NOW()/CURRENT_TIMESTAMP/boolean/null keywords, numeric
 * literals) — anything else becomes a safely-quoted string literal, so nothing
 * authored here can inject SQL.
 */

/** Compilation context: the schema/table the trigger is attached to and the trigger's own name. */
type CompileCtx = { schemaName: string; tableName: string; triggerName: string };

export interface CompiledTrigger {
  /** DDL statements: optional CREATE FUNCTION, then DROP/CREATE TRIGGER. */
  statements: string[];
}

const EVENT_TIMINGS = ['BEFORE', 'AFTER', 'INSTEAD OF'];
const EVENTS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
const KEYWORDS = new Set(['NOW()', 'CURRENT_TIMESTAMP', 'TG_OP', 'TG_TABLE_NAME', 'TG_WHEN', 'TRUE', 'FALSE', 'NULL']);
const OP_MAP: Record<string, string> = {
  GT: '>', LT: '<', EQ: '=', GTE: '>=', LTE: '<=', NEQ: '<>', NE: '<>',
  '>': '>', '<': '<', '=': '=', '>=': '>=', '<=': '<=', '!=': '<>', '<>': '<>',
};

/**
 * Compiles a declarative trigger definition (procedure / execute / mini action DSL)
 * into safe native Postgres trigger DDL — no hand-written plpgsql required.
 * @class
 * @hideconstructor
 */
export class TriggerActionCompiler {
  /**
   * Strip a string to a bare SQL identifier ([A-Za-z0-9_]) — the core
   * defense against SQL injection through user-authored names (trigger,
   * table, column, function names).
   * @param s - The raw candidate identifier.
   * @returns The sanitized identifier (may be an empty string if nothing valid remained).
   */
  static ident(s: any): string {
    return String(s || '').replace(/[^a-zA-Z0-9_]/g, '');
  }

  /**
   * Quote a single identifier, or a `schema.table` pair, defaulting bare
   * names to `defaultSchema`.
   * @param name - A bare identifier, or a `schema.table` dotted pair.
   * @param defaultSchema - Schema to qualify `name` with when it has no dot.
   * @returns A double-quoted, schema-qualified SQL identifier, e.g. `"schema"."table"`.
   */
  static qualify(name: any, defaultSchema: string): string {
    const raw = String(name || '').trim();
    if (raw.includes('.')) {
      const [s, t] = raw.split('.');
      return `"${this.ident(s)}"."${this.ident(t)}"`;
    }
    return `"${this.ident(defaultSchema)}"."${this.ident(raw)}"`;
  }

  /**
   * Compile a value into a safe SQL scalar expression. Recognised forms pass
   * through; everything else is treated as a string literal (quoted+escaped).
   * @param v - The raw value: `null`/`undefined`, a number, a boolean, a
   *   `NEW.col`/`OLD.col` reference, a numeric-looking string, a whitelisted
   *   keyword (NOW(), TG_OP, ...), an already-quoted SQL literal, or an opaque string.
   * @returns A safe SQL scalar expression string.
   */
  static expr(v: any): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    const s = String(v).trim();
    const colRef = s.match(/^(NEW|OLD)\.([A-Za-z_][A-Za-z0-9_]*)$/i);
    if (colRef) return `${(colRef[1] || '').toUpperCase()}."${colRef[2] || ''}"`;
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;
    if (KEYWORDS.has(s.toUpperCase())) return s.toUpperCase();
    // Already a single-quoted SQL string literal (no interior quotes) → pass through.
    if (/^'[^']*'$/.test(s)) return s;
    // Fallback: opaque value → string literal (escape embedded quotes).
    return `'${s.replace(/'/g, "''")}'`;
  }

  /**
   * Compile a structured condition into a boolean SQL expression. Supports
   * nested `and`/`or` groups and a single `{ left, operator, right }` leaf
   * (including `IS_NULL`/`IS_NOT_NULL`, which take only `left`).
   * @param c - The condition node, or a falsy value for an always-true condition.
   * @returns A boolean SQL expression string.
   * @throws {Error} If `c.operator`/`c.op` is not a supported comparison operator.
   */
  static condition(c: any): string {
    if (!c) return 'TRUE';
    if (Array.isArray(c.and)) return `(${c.and.map((x: any) => this.condition(x)).join(' AND ')})`;
    if (Array.isArray(c.or)) return `(${c.or.map((x: any) => this.condition(x)).join(' OR ')})`;
    const op = String(c.operator || c.op || 'EQ').toUpperCase();
    if (op === 'IS_NULL') return `${this.expr(c.left)} IS NULL`;
    if (op === 'IS_NOT_NULL') return `${this.expr(c.left)} IS NOT NULL`;
    const sqlOp = OP_MAP[op];
    if (!sqlOp) throw new Error(`Unsupported condition operator: ${op}`);
    return `${this.expr(c.left)} ${sqlOp} ${this.expr(c.right)}`;
  }

  /**
   * Escape a message for a RAISE literal.
   * @param m - The user-authored message, or nullish to use `fallback`.
   * @param fallback - Default message when `m` is not provided.
   * @returns The message with embedded single quotes escaped (doubled).
   */
  private static msg(m: any, fallback: string): string {
    return String(m || fallback).replace(/'/g, "''");
  }

  /**
   * Compile a single mini action-DSL node into its SQL body statements (no
   * surrounding BEGIN/END/RETURN) — the workhorse behind the `action` form
   * and the `EXCEPTION`/`FUNCTION` cases of `execute`. Supports a raw `sql`
   * escape hatch, plus `INSERT`/`UPDATE`/`DELETE`/`RAISE`(`EXCEPTION`)/`PERFORM`(`FUNCTION`).
   * @param action - The action node (`{ sql }` or `{ type, ... }`).
   * @param ctx - Compilation context (used to qualify target tables/functions).
   * @returns One or more SQL statements as a single string, terminated with `;`.
   * @throws {Error} If a required field is missing (e.g. `values`/`set`/`where`)
   *   or `action.type` is unsupported.
   */
  static compileActionBody(action: any, ctx: CompileCtx): string {
    if (action?.sql) {
      // Raw single-statement escape hatch. Trusted (manifest-authored); trailing
      // semicolons stripped so we always emit exactly one statement.
      return `${String(action.sql).trim().replace(/;+\s*$/, '')};`;
    }
    const type = String(action?.type || '').toUpperCase();
    switch (type) {
      case 'INSERT': {
        const target = this.qualify(action.into || action.table, ctx.schemaName);
        const values = action.values || {};
        const cols = Object.keys(values);
        if (!cols.length) throw new Error('INSERT action requires values');
        const colList = cols.map((c) => `"${this.ident(c)}"`).join(', ');
        const valList = cols.map((c) => this.expr(values[c])).join(', ');
        return `INSERT INTO ${target} (${colList}) VALUES (${valList});`;
      }
      case 'UPDATE': {
        const target = this.qualify(action.table || action.into, ctx.schemaName);
        const set = action.set || {};
        const cols = Object.keys(set);
        if (!cols.length) throw new Error('UPDATE action requires set');
        if (!action.where) throw new Error('UPDATE action requires where (refusing full-table update)');
        const setList = cols.map((c) => `"${this.ident(c)}" = ${this.expr(set[c])}`).join(', ');
        return `UPDATE ${target} SET ${setList} WHERE ${this.condition(action.where)};`;
      }
      case 'DELETE': {
        const target = this.qualify(action.from || action.table, ctx.schemaName);
        if (!action.where) throw new Error('DELETE action requires where (refusing full-table delete)');
        return `DELETE FROM ${target} WHERE ${this.condition(action.where)};`;
      }
      case 'RAISE':
      case 'EXCEPTION': {
        const message = this.msg(action.message, 'Trigger rule violation');
        if (action.when) return `IF (${this.condition(action.when)}) THEN RAISE EXCEPTION '${message}'; END IF;`;
        return `RAISE EXCEPTION '${message}';`;
      }
      case 'PERFORM':
      case 'FUNCTION': {
        const fn = this.qualify(action.function || action.name, ctx.schemaName);
        const args = Array.isArray(action.args) ? action.args.map((a: any) => this.expr(a)).join(', ') : '';
        return `PERFORM ${fn}(${args});`;
      }
      default:
        throw new Error(`Unsupported action type: ${type || '(none)'}`);
    }
  }

  /**
   * SQL expression for a durable job's run_at, evaluated in the trigger body.
   * Mirrors the trigger-engine RELATIVE-schedule semantics: anchor off a row
   * column when given, else off firing time; both plus after·unit.
   * @param schedule - The trigger's `schedule` definition; non-RELATIVE (or absent) schedules resolve to `NOW()`.
   * @returns A SQL expression (timestamptz) referencing NEW/OLD as needed.
   */
  static runAtExpr(schedule: any): string {
    if (!schedule || String(schedule.type || '').toUpperCase() !== 'RELATIVE') return 'NOW()';
    const after = Math.max(0, Math.floor(Number(schedule.after ?? schedule.every ?? 0)) || 0);
    const unitRaw = String(schedule.unit || 'MINUTE').toUpperCase();
    const unit = ['SECOND', 'MINUTE', 'HOUR', 'DAY', 'MONTH'].includes(unitRaw) ? unitRaw : 'MINUTE';
    const interval = after > 0 ? ` + INTERVAL '${after} ${unit}'` : '';
    const col = this.ident(schedule.column || schedule.relativeColumn || '');
    if (col) {
      return `COALESCE((row_to_json(NEW)->>'${col}')::timestamptz, (row_to_json(OLD)->>'${col}')::timestamptz, NOW())${interval}`;
    }
    return `NOW()${interval}`;
  }

  /**
   * Body statements for a durable action (WEBHOOK/EMAIL/TELEGRAM): enqueue an
   * EXECUTE_TRIGGER_ACTION job the trigger-engine worker will dispatch. Uses the
   * live session GUCs (set by queryWithContext at write time) for tenant/user.
   * @param trigger - The trigger definition (`execute`, `event`/`events`, `schedule`).
   * @param ctx - Compilation context (schema/table/trigger name for the job payload).
   * @returns An `INSERT INTO public.trigger_jobs (...)` statement referencing NEW/OLD.
   */
  static compileEnqueueBody(trigger: any, ctx: CompileCtx): string {
    const type = String(trigger.execute?.type || '').toUpperCase();
    const executeJson = JSON.stringify(trigger.execute || {}).replace(/'/g, "''");
    const scheduleJson = trigger.schedule ? `'${JSON.stringify(trigger.schedule).replace(/'/g, "''")}'::jsonb` : 'NULL';
    const maxAttempts = Math.max(1, Number(trigger.schedule?.maxAttempts || 5));
    const eventName = this.ident(trigger.event || (Array.isArray(trigger.events) ? trigger.events[0] : 'INSERT')).toUpperCase();
    return `
      INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
      VALUES (
        current_setting('app.tenant_id', true), NULL, 'EXECUTE_TRIGGER_ACTION',
        jsonb_build_object(
          'triggerName', '${this.ident(ctx.triggerName)}',
          'event', '${eventName}',
          'actionType', '${type}',
          'tableName', '${ctx.tableName}',
          'schemaName', '${ctx.schemaName}',
          'newRow', row_to_json(NEW),
          'oldRow', row_to_json(OLD),
          'execute', '${executeJson}'::jsonb,
          'schedule', ${scheduleJson}
        ),
        'PENDING', ${this.runAtExpr(trigger.schedule)}, ${maxAttempts}, current_setting('app.user_name', true)
      );`;
  }

  /**
   * Resolve a declarative `execute` block to either a bare procedure name
   * (native EXECUTE FUNCTION) or a compiled function body.
   * @param trigger - The trigger definition; `trigger.execute.type` selects AUDIT/FUNCTION/EXCEPTION/WEBHOOK/EMAIL/TELEGRAM.
   * @param ctx - Compilation context passed through to the relevant compiler.
   * @returns `{ procedure }` for AUDIT/FUNCTION, or `{ body, securityDefiner }` for EXCEPTION/WEBHOOK/EMAIL/TELEGRAM.
   * @throws {Error} If `trigger.execute.type` is not a supported type.
   */
  static compileExecute(trigger: any, ctx: CompileCtx): { procedure?: string; body?: string; securityDefiner?: boolean } {
    const type = String(trigger.execute?.type || '').toUpperCase();
    switch (type) {
      case 'AUDIT':
        // Sugar for the built-in SECURITY DEFINER audit primitive.
        return { procedure: 'audit_log_fn' };
      case 'FUNCTION':
        return { body: `PERFORM ${this.qualify(trigger.execute.name, ctx.schemaName)}();` };
      case 'EXCEPTION':
        return { body: this.compileActionBody({ type: 'RAISE', when: trigger.execute.when, message: trigger.execute.message }, ctx) };
      case 'WEBHOOK':
      case 'EMAIL':
      case 'TELEGRAM':
        // SECURITY DEFINER so the enqueue can write the control-plane queue
        // regardless of which tenant role fired the trigger.
        return { body: this.compileEnqueueBody(trigger, ctx), securityDefiner: true };
      default:
        throw new Error(`Unsupported execute.type: ${type || '(none)'}`);
    }
  }

  /**
   * Full DDL for a declarative trigger (action, execute, or bare procedure
   * forms): resolves timing/events/level, compiles the body (if not using an
   * existing procedure), and emits the CREATE FUNCTION (when needed) plus
   * DROP/CREATE TRIGGER statements ready to execute in order.
   * @param trigger - The full trigger definition (name, timing, event(s), action/execute/procedure).
   * @param ctx - Compilation context (schema, table, trigger name).
   * @returns `{ statements }` — DDL statements to run in sequence.
   * @throws {Error} If the trigger declares none of `action`, `execute`, `procedure`, or `function`.
   */
  static toSql(trigger: any, ctx: CompileCtx): CompiledTrigger {
    const name = this.ident(trigger.name);
    const timing = EVENT_TIMINGS.includes(String(trigger.timing || '').toUpperCase())
      ? String(trigger.timing).toUpperCase()
      : this.timingFromEvent(trigger.event) || 'AFTER';
    const events = this.normalizeEvents(trigger);
    const level = String(trigger.execution || trigger.forEach || trigger.scope || 'row').toLowerCase() === 'statement' ? 'STATEMENT' : 'ROW';
    const table = `"${this.ident(ctx.schemaName)}"."${this.ident(ctx.tableName)}"`;

    // Resolve to either a procedure reference or a compiled body.
    let procedure: string | undefined;
    let body: string | undefined;
    let securityDefiner = false;

    if (trigger.action) {
      body = this.compileActionBody(trigger.action, ctx);
    } else if (trigger.execute?.type) {
      const resolved = this.compileExecute(trigger, ctx);
      procedure = resolved.procedure;
      body = resolved.body;
      securityDefiner = !!resolved.securityDefiner;
    } else if (trigger.procedure || trigger.function) {
      // `function` is a legacy alias for `procedure` (EXECUTE an existing trigger fn).
      procedure = trigger.procedure || trigger.function;
    } else {
      throw new Error(`trigger ${name || '(unnamed)'}: needs one of action, execute, procedure, or function`);
    }

    const statements: string[] = [];
    let procRef: string;
    if (procedure) {
      procRef = procedure.includes('.')
        ? procedure.split('.').map((p) => `"${this.ident(p)}"`).join('.')
        : `public."${this.ident(procedure)}"`;
    } else {
      // Generate a dedicated trigger function that runs the compiled body.
      const fnName = `${name}_fn`;
      procRef = `"${this.ident(ctx.schemaName)}"."${fnName}"`;
      statements.push(
        `CREATE OR REPLACE FUNCTION ${procRef}() RETURNS TRIGGER AS $DFTRG$\n` +
        `BEGIN\n  ${body}\n  RETURN COALESCE(NEW, OLD);\nEND;\n$DFTRG$ LANGUAGE plpgsql${securityDefiner ? ' SECURITY DEFINER' : ''}`
      );
    }

    statements.push(`DROP TRIGGER IF EXISTS "${name}" ON ${table}`);
    statements.push(`CREATE TRIGGER "${name}" ${timing} ${events} ON ${table} FOR EACH ${level} EXECUTE FUNCTION ${procRef}()`);
    return { statements };
  }

  /**
   * Resolve the trigger's firing event(s) into a Postgres `CREATE TRIGGER`
   * event clause. Accepts an explicit `events` array, the API's combined
   * `event` form (e.g. `'AFTER_INSERT'`, from which only the event part is
   * kept), or a bare `events` string; unrecognised events are dropped and
   * `INSERT` is used as the fallback if nothing valid remains.
   * @param trigger - The trigger definition (`events`, `event`, or nothing).
   * @returns An `OR`-joined event list valid inside `CREATE TRIGGER ... FOR EACH ROW`, e.g. `"INSERT OR UPDATE"`.
   */
  private static normalizeEvents(trigger: any): string {
    let evs: string[];
    if (Array.isArray(trigger.events)) evs = trigger.events;
    else if (trigger.event) {
      // API form 'AFTER_INSERT' → INSERT ; or bare 'INSERT'.
      const parts = String(trigger.event).toUpperCase().split('_');
      evs = [parts[parts.length - 1] || 'INSERT'];
    } else evs = [trigger.events || 'INSERT'];
    const filtered = evs.map((e) => String(e).toUpperCase()).filter((e) => EVENTS.includes(e));
    return filtered.length ? filtered.join(' OR ') : 'INSERT';
  }

  /**
   * Infer a trigger's timing (`BEFORE`/`AFTER`/`INSTEAD OF`) from a combined
   * event label such as `'AFTER_INSERT'`, used as a fallback when
   * `trigger.timing` is not explicitly set.
   * @param event - The combined event label, if any.
   * @returns The inferred timing keyword, or `null` if it cannot be determined.
   */
  private static timingFromEvent(event: any): string | null {
    if (!event) return null;
    const up = String(event).toUpperCase();
    if (up.startsWith('BEFORE')) return 'BEFORE';
    if (up.startsWith('AFTER')) return 'AFTER';
    if (up.startsWith('INSTEAD')) return 'INSTEAD OF';
    return null;
  }
}
