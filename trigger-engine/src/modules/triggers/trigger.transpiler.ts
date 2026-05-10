import { TriggerDefinition } from './trigger.types';

export class TriggerTranspiler {
    static toSql(trg: TriggerDefinition, schemaName: string, tableName: string): string[] {
        this.validate(trg);
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
                const runAtExpr = trg.schedule?.type === 'RELATIVE' && trg.schedule.after 
                    ? `NOW() + INTERVAL '${trg.schedule.after} ${trg.schedule.unit || 'MINUTE'}'` 
                    : 'NOW()';
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
                        ${runAtExpr},
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

    private static validate(trg: TriggerDefinition) {
        if (!trg.name) throw new Error("Trigger 'name' is required.");
        if (!trg.event) throw new Error(`Trigger '${trg.name}' must specify an 'event'.`);
        if (!trg.execute) throw new Error(`Trigger '${trg.name}' must specify an 'execute' block.`);
        if (!trg.execute.type) throw new Error(`Trigger '${trg.name}' execution 'type' is required.`);

        if (trg.execute.type === 'WEBHOOK' && !trg.execute.url) {
            throw new Error(`Trigger '${trg.name}' of type WEBHOOK requires a 'url'.`);
        }

        if (trg.schedule) {
            if (trg.schedule.type === 'RELATIVE' && (!trg.schedule.after || !trg.schedule.unit)) {
                throw new Error(`Trigger '${trg.name}' with RELATIVE schedule requires 'after' and 'unit'.`);
            }
            if (trg.schedule.type === 'FIXED' && (!trg.schedule.every || !trg.schedule.unit)) {
                throw new Error(`Trigger '${trg.name}' with FIXED schedule requires 'every' and 'unit'.`);
            }
            if (trg.schedule.type === 'CRON' && !trg.schedule.cron) {
                throw new Error(`Trigger '${trg.name}' with CRON schedule requires a 'cron' string.`);
            }
        }
    }

    public static astToSql(ast: any): string {
        if (!ast) return 'TRUE';
        if (typeof ast === 'string') return ast;
        if (ast.expression) return ast.expression;

        const left = ast.column || ast.left;
        const operator = ast.operator;
        const right = ast.expression || (ast.value !== undefined ? ast.value : ast.right);
        
        if (!left || !operator) {
            throw new Error(`Malformed condition AST: 'column' and 'operator' are required. Received: ${JSON.stringify(ast)}`);
        }

        const opMap: any = { 
            'EQ': '=', 'NE': '!=', 'GT': '>', 'LT': '<', 'GTE': '>=', 'LTE': '<=',
            'LIKE': 'LIKE', 'ILIKE': 'ILIKE', 'IN': 'IN', 'IS_NULL': 'IS NULL', 'IS_NOT_NULL': 'IS NOT NULL'
        };
        
        const op = opMap[operator.toUpperCase()];
        if (!op) {
            throw new Error(`Unsupported operator: '${operator}'. Supported: ${Object.keys(opMap).join(', ')}`);
        }
        
        if (op === 'IS NULL' || op === 'IS NOT NULL') {
            return `${left} ${op}`;
        }

        if (right === undefined) {
            throw new Error(`Condition for '${left}' with operator '${operator}' is missing a 'value' or 'expression'.`);
        }

        let finalRight = right;
        if (typeof right === 'object' && right !== null && right.expression) {
            finalRight = right.expression;
        } 
        else if (typeof right === 'string') {
            const isColumnRef = right.startsWith('NEW.') || right.startsWith('OLD.');
            const isAlreadyQuoted = right.startsWith("'");
            if (!isColumnRef && !isAlreadyQuoted) {
                finalRight = `'${right}'`;
            }
        }

        if (op === 'IN') {
            if (!Array.isArray(right)) throw new Error(`Operator 'IN' requires an array as its value.`);
            const values = right.map(v => typeof v === 'string' && !v.startsWith("'") ? `'${v}'` : v).join(', ');
            return `${left} IN (${values})`;
        }

        return `${left} ${op} ${finalRight}`;
    }
}
