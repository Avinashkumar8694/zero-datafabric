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
                    INSERT INTO public.task_queue (tenant_id, task_type, payload)
                    VALUES (current_setting('app.tenant_id', true), 'CLEANUP_TRIGGER', jsonb_build_object('trigger', '${trg.name}', 'table', '${tableName}', 'schema', '${schemaName}'));
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
                code += `
                    INSERT INTO public.task_queue (tenant_id, task_type, payload, schedule)
                    VALUES (
                        current_setting('app.tenant_id', true), 
                        '${trg.execute.type}', 
                        row_to_json(NEW),
                        ${trg.schedule ? `'${JSON.stringify(trg.schedule)}'::jsonb` : 'NULL'}
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
