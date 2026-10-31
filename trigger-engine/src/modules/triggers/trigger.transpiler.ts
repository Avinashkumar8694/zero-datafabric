import { TriggerDefinition } from './trigger.types';
import { assertIdent, belongsToTenant, quoteIdent } from '../../utils/identifiers';
import { assertSafeWebhookUrl } from '../../utils/net_guard';

/**
 * Transpiles a trigger definition into plpgsql DDL. Every identifier is validated (never interpolated raw), conditions
 * are compiled from a structured form through a small whitelist (anything else becomes a quoted literal) and embedded
 * JSON is escaped, so a definition can never break out of the generated statements. When `opts.tenantId` is given the
 * target schema must be inside that tenant's namespace.
 */
export interface TranspileOptions { tenantId?: string }

const EVENT_RE = /^(BEFORE|AFTER|INSTEAD_OF)_(INSERT|UPDATE|DELETE)$/;
const KEYWORDS = new Set(['NOW()', 'CURRENT_TIMESTAMP', 'TG_OP', 'TG_TABLE_NAME', 'TG_WHEN', 'TRUE', 'FALSE', 'NULL']);
const OP_MAP: Record<string, string> = {
    GT: '>', LT: '<', EQ: '=', GTE: '>=', LTE: '<=', NEQ: '<>', NE: '<>',
    '>': '>', '<': '<', '=': '=', '>=': '>=', '<=': '<=', '!=': '<>', '<>': '<>',
};
const BODY_TAG = '$DFTRGE$';

function lit(v: any): string {
    return `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

export class TriggerTranspiler {
    static toSql(trg: TriggerDefinition, schemaName: string, tableName: string, opts: TranspileOptions = {}): string[] {
        const name = assertIdent(trg.name, 'trigger name');
        const schema = assertIdent(schemaName, 'schema');
        const table = assertIdent(tableName, 'table');
        if (opts.tenantId && !belongsToTenant(schema, opts.tenantId)) throw new Error(`Trigger target schema "${schema}" is outside the workspace`);
        const m = EVENT_RE.exec(String(trg.event || '').toUpperCase());
        if (!m) throw new Error('Invalid trigger event');
        const timing = m[1] === 'INSTEAD_OF' ? 'INSTEAD OF' : (m[1] as string);
        const op = m[2] as string;
        const fnName = `${name}_func`;
        const S = quoteIdent(schema, 'schema');
        const T = `${S}.${quoteIdent(table, 'table')}`;

        const sql: string[] = [];
        const body = this.generateFunctionBody(trg, schema, table, name, opts);
        if (body.includes(BODY_TAG) || body.includes('$$')) throw new Error('Trigger body must not contain dollar-quote delimiters');

        sql.push(`
            CREATE OR REPLACE FUNCTION ${S}.${quoteIdent(fnName, 'function name')}()
            RETURNS TRIGGER AS $$
            BEGIN
                ${body}
            END;
            $$ LANGUAGE plpgsql;
        `);

        sql.push(`DROP TRIGGER IF EXISTS ${quoteIdent(name, 'trigger name')} ON ${T}`);
        sql.push(`
            CREATE TRIGGER ${quoteIdent(name, 'trigger name')}
            ${timing} ${op} ON ${T}
            FOR EACH ROW
            ${trg.condition ? `WHEN (${this.astToSql(trg.condition)})` : ''}
            EXECUTE FUNCTION ${S}.${quoteIdent(fnName, 'function name')}();
        `);

        return sql;
    }

    private static generateFunctionBody(trg: TriggerDefinition, schemaName: string, tableName: string, name: string, opts: TranspileOptions): string {
        let code = '';

        // 1. autoDrop Logic (Self-Cleanup Registration)
        if (trg.autoDrop) {
            code += `
                IF (${this.astToSql(trg.autoDrop.when)}) THEN
                    INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
                    VALUES (
                      current_setting('app.tenant_id', true),
                      NULL,
                      'CLEANUP_TRIGGER',
                      jsonb_build_object('triggerName', ${lit(name)}, 'tableName', ${lit(tableName)}, 'schemaName', ${lit(schemaName)}),
                      'PENDING',
                      NOW(),
                      5,
                      current_setting('app.user_name', true)
                    );
                END IF;
            `;
        }

        // 2. Main Execution
        switch (trg.execute.type) {
            case 'EXCEPTION': {
                const when = trg.execute.when ? `IF (${this.astToSql(trg.execute.when)}) THEN` : 'IF (TRUE) THEN';
                const message = String(trg.execute.message || 'Business Rule Violation').replace(/\0/g, '').replace(/'/g, "''").replace(/%/g, '%%');
                code += `
                    ${when}
                        RAISE EXCEPTION '${message}';
                    END IF;
                `;
                break;
            }

            case 'WEBHOOK':
            case 'AUDIT':
            case 'EMAIL':
            case 'TELEGRAM': {
                if (trg.execute.url !== undefined && trg.execute.url !== null) assertSafeWebhookUrl(trg.execute.url);
                const actionType = String(trg.execute.type);
                const maxAttempts = Math.min(20, Math.max(1, Math.floor(Number(trg.schedule?.maxAttempts || 5)) || 5));
                code += `
                    INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
                    VALUES (
                        current_setting('app.tenant_id', true),
                        NULL,
                        'EXECUTE_TRIGGER_ACTION',
                        jsonb_build_object(
                          'triggerName', ${lit(name)},
                          'event', ${lit(trg.event)},
                          'actionType', ${lit(actionType)},
                          'tableName', ${lit(tableName)},
                          'schemaName', ${lit(schemaName)},
                          'newRow', row_to_json(NEW),
                          'oldRow', row_to_json(OLD),
                          'execute', ${lit(JSON.stringify(trg.execute || {}))}::jsonb,
                          'schedule', ${trg.schedule ? `${lit(JSON.stringify(trg.schedule))}::jsonb` : 'NULL'}
                        ),
                        'PENDING',
                        ${this.runAtExpr(trg)},
                        ${maxAttempts},
                        current_setting('app.user_name', true)
                    );
                `;
                break;
            }

            case 'FUNCTION': {
                const fn = String(trg.execute.name || '');
                if (fn.includes('.')) {
                    const [fs, fname] = fn.split('.');
                    if (fn.split('.').length !== 2 || !opts.tenantId || !belongsToTenant(assertIdent(fs, 'schema'), opts.tenantId)) throw new Error('Qualified function names must be inside the workspace');
                    code += `PERFORM ${quoteIdent(fs, 'schema')}.${quoteIdent(fname, 'function')}();`;
                } else {
                    code += `PERFORM ${quoteIdent(schemaName, 'schema')}.${quoteIdent(fn, 'function')}();`;
                }
                break;
            }

            default:
                throw new Error(`Unsupported execute.type: ${String((trg.execute as any).type)}`);
        }

        code += '\nRETURN NEW;';
        return code;
    }

    /**
     * SQL expression for a fired action's run_at, evaluated inside the trigger
     * function on the affected row.
     *
     * - No schedule, or a non-RELATIVE schedule → fire immediately (NOW()).
     * - RELATIVE with no anchor column → NOW() + after·unit (delay from firing time).
     * - RELATIVE with an anchor column → the row's column value
     *   (NEW on insert/update, OLD on delete) + after·unit; falls back to NOW()
     *   when the column is null/absent so a bad column never drops the job.
     *
     * `after`/`unit` are numbers / whitelisted words and the column is a validated identifier, so nothing here is
     * interpolated from untrusted free text.
     */
    private static runAtExpr(trg: TriggerDefinition): string {
        const s = trg.schedule;
        if (!s || String(s.type || '').toUpperCase() !== 'RELATIVE') return 'NOW()';
        const after = Math.min(1_000_000, Math.max(0, Math.floor(Number(s.after ?? s.every ?? 0)) || 0));
        const unitRaw = String(s.unit || 'MINUTE').toUpperCase();
        const unit = ['SECOND', 'MINUTE', 'HOUR', 'DAY', 'MONTH'].includes(unitRaw) ? unitRaw : 'MINUTE';
        const interval = after > 0 ? ` + INTERVAL '${after} ${unit}'` : '';
        const rawCol = s.column || s.relativeColumn || '';
        const col = rawCol ? assertIdent(rawCol, 'schedule column') : '';
        if (col) {
            // Anchor off the row's timestamp column; row_to_json(NEW/OLD) is NULL for the
            // absent side (OLD on insert, NEW on delete), so COALESCE selects the right one.
            return `COALESCE((row_to_json(NEW)->>'${col}')::timestamptz, (row_to_json(OLD)->>'${col}')::timestamptz, NOW())${interval}`;
        }
        return `NOW()${interval}`;
    }

    /** A scalar: NEW./OLD. column ref, number, whitelisted keyword, boolean, or a quoted literal. Nothing else is passed through. */
    private static valueToSql(v: any): string {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('Invalid number'); return String(v); }
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        const s = String(v).trim();
        const colRef = s.match(/^(NEW|OLD)\.([A-Za-z_][A-Za-z0-9_]{0,62})$/i);
        if (colRef) return `${(colRef[1] as string).toUpperCase()}.${quoteIdent(colRef[2], 'column')}`;
        if (/^-?\d+(\.\d+)?$/.test(s)) return s;
        if (KEYWORDS.has(s.toUpperCase())) return s.toUpperCase();
        if (/^'[^']*'$/.test(s)) return s.includes('\0') ? lit('') : s;
        return lit(s);
    }

    /** Structured condition → boolean SQL. String (free-form) conditions are rejected. */
    private static astToSql(ast: any, depth = 0): string {
        if (!ast) return 'TRUE';
        if (depth > 6) throw new Error('Condition is nested too deeply');
        if (typeof ast === 'string') throw new Error('Free-form string conditions are not allowed; use { left, operator, right }');
        if (Array.isArray(ast.and)) return `(${ast.and.map((x: any) => this.astToSql(x, depth + 1)).join(' AND ')})`;
        if (Array.isArray(ast.or)) return `(${ast.or.map((x: any) => this.astToSql(x, depth + 1)).join(' OR ')})`;
        const op = String(ast.operator || ast.op || 'EQ').toUpperCase();
        if (op === 'IS_NULL') return `${this.valueToSql(ast.left)} IS NULL`;
        if (op === 'IS_NOT_NULL') return `${this.valueToSql(ast.left)} IS NOT NULL`;
        const sqlOp = OP_MAP[op];
        if (!sqlOp) throw new Error(`Unsupported condition operator: ${op.slice(0, 20)}`);
        if (ast.left === undefined || ast.right === undefined) return 'TRUE';
        return `${this.valueToSql(ast.left)} ${sqlOp} ${this.valueToSql(ast.right)}`;
    }
}
