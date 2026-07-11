import { TriggerDefinition } from './trigger.types';

export class TriggerTranspiler {
    static toSql(trg: TriggerDefinition, schemaName: string, tableName: string): string[] {
        const sql: string[] = [];
        const fnName = `${trg.name}_func`;
        const timing = trg.event.split('_')[0]; 
        const op = trg.event.split('_').slice(1).join('_'); 

        const body = this.generateFunctionBody(trg, schemaName, tableName);

        sql.push(`
            CREATE OR REPLACE FUNCTION "${schemaName}"."${fnName}"()
            RETURNS TRIGGER AS $$
            BEGIN
                ${body}
            END;
            $$ LANGUAGE plpgsql;
        `);

        sql.push(`DROP TRIGGER IF EXISTS "${trg.name}" ON "${schemaName}"."${tableName}"`);
        sql.push(`
            CREATE TRIGGER "${trg.name}"
            ${timing} ${op} ON "${schemaName}"."${tableName}"
            FOR EACH ROW
            ${trg.condition ? `WHEN (${this.astToSql(trg.condition)})` : ''}
            EXECUTE FUNCTION "${schemaName}"."${fnName}"();
        `);

        return sql;
    }

    private static generateFunctionBody(trg: TriggerDefinition, schemaName: string, tableName: string): string {
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
                      jsonb_build_object('triggerName', '${trg.name}', 'tableName', '${tableName}', 'schemaName', '${schemaName}'),
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
            case 'EXCEPTION':
                const when = trg.execute.when ? `IF (${this.astToSql(trg.execute.when)}) THEN` : 'IF (TRUE) THEN';
                code += `
                    ${when}
                        RAISE EXCEPTION '${trg.execute.message || 'Business Rule Violation'}';
                    END IF;
                `;
                break;

            case 'WEBHOOK':
            case 'AUDIT':
            case 'EMAIL':
            case 'TELEGRAM':
                code += `
                    INSERT INTO public.trigger_jobs (tenant_id, trigger_id, job_type, payload, status, run_at, max_attempts, created_by)
                    VALUES (
                        current_setting('app.tenant_id', true), 
                        NULL,
                        'EXECUTE_TRIGGER_ACTION',
                        jsonb_build_object(
                          'triggerName', '${trg.name}',
                          'event', '${trg.event}',
                          'actionType', '${trg.execute.type}',
                          'tableName', '${tableName}',
                          'schemaName', '${schemaName}',
                          'newRow', row_to_json(NEW),
                          'oldRow', row_to_json(OLD),
                          'execute', '${JSON.stringify(trg.execute || {})}'::jsonb,
                          'schedule', ${trg.schedule ? `'${JSON.stringify(trg.schedule)}'::jsonb` : 'NULL'}
                        ),
                        'PENDING',
                        ${this.runAtExpr(trg)},
                        ${trg.schedule?.maxAttempts || 5},
                        current_setting('app.user_name', true)
                    );
                `;
                break;

            case 'FUNCTION':
                code += `PERFORM "${schemaName}"."${trg.execute.name}"();`;
                break;
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
     * `after`/`unit` and the column identifier are sanitised — the column is
     * stripped to [A-Za-z0-9_] and the unit is whitelisted — so nothing here is
     * interpolated from untrusted free text.
     */
    private static runAtExpr(trg: TriggerDefinition): string {
        const s = trg.schedule;
        if (!s || String(s.type || '').toUpperCase() !== 'RELATIVE') return 'NOW()';
        const after = Math.max(0, Math.floor(Number(s.after ?? s.every ?? 0)) || 0);
        const unitRaw = String(s.unit || 'MINUTE').toUpperCase();
        const unit = ['SECOND', 'MINUTE', 'HOUR', 'DAY', 'MONTH'].includes(unitRaw) ? unitRaw : 'MINUTE';
        const interval = after > 0 ? ` + INTERVAL '${after} ${unit}'` : '';
        const col = String(s.column || s.relativeColumn || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (col) {
            // Anchor off the row's timestamp column; row_to_json(NEW/OLD) is NULL for the
            // absent side (OLD on insert, NEW on delete), so COALESCE selects the right one.
            return `COALESCE((row_to_json(NEW)->>'${col}')::timestamptz, (row_to_json(OLD)->>'${col}')::timestamptz, NOW())${interval}`;
        }
        return `NOW()${interval}`;
    }

    private static astToSql(ast: any): string {
        if (!ast) return 'TRUE';
        if (typeof ast === 'string') return ast;
        if (ast.left && ast.operator && ast.right) {
            const opMap: any = { 'GT': '>', 'LT': '<', 'EQ': '=', 'GTE': '>=', 'LTE': '<=', 'NEQ': '!=' };
            const op = opMap[ast.operator] || ast.operator;
            return `${ast.left} ${op} ${ast.right}`;
        }
        return 'TRUE';
    }
}
