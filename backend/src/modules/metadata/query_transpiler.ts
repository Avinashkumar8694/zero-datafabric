export class QueryTranspiler {
    static toSql(query: any, schemaName: string, ctes: string[] = []): string {
        if (typeof query === 'string') return query;

        let sql = '';
        const currentCtes = [...ctes];

        if (query.with) {
            for (const w of query.with) currentCtes.push(w.name);

            const withBlocks = query.with.map((w: any) => {
                const cols = w.columns ? `(${w.columns.join(', ')})` : '';
                const base = this.toSql(w.base, schemaName, currentCtes);
                const union = w.unionAll ? ` UNION ALL ${this.toSql(w.unionAll, schemaName, currentCtes)}` : '';
                return `"${w.name}"${cols} AS (${base}${union})`;
            }).join(', ');
            sql += `WITH ${query.recursive ? 'RECURSIVE ' : ''}${withBlocks} `;
        }

        sql += 'SELECT ';
        if (query.select) {
            sql += query.select.map((s: any) => this.selectItemToSql(s)).join(', ');
        } else {
            sql += '*';
        }

        if (query.from) {
            const isCte = currentCtes.includes(query.from.resource);
            const fromSource = isCte ? `"${query.from.resource}"` : `"${schemaName}"."${query.from.resource}"`;
            sql += ` FROM ${fromSource}`;
            if (query.from.alias) sql += ` AS "${query.from.alias}"`;
        }

        if (query.joins) {
            for (const join of query.joins) {
                const isCte = currentCtes.includes(join.resource);
                const joinSource = isCte ? `"${join.resource}"` : `"${schemaName}"."${join.resource}"`;
                sql += ` ${join.type || 'INNER'} JOIN ${joinSource} AS "${join.alias}" ON ${join.on.left} ${this.mapOp(join.on.operator)} ${join.on.right}`;
            }
        }

        if (query.where) {
            sql += ' WHERE ' + query.where.map((w: any) => this.whereToSql(w)).join(' AND ');
        }

        if (query.groupBy) {
            sql += ' GROUP BY ' + query.groupBy.join(', ');
        }

        return sql;
    }

    private static selectItemToSql(s: any): string {
        if (typeof s === 'string') return s;
        if (s.aggregate) return `${s.aggregate}(${s.column}) AS "${s.alias || s.column}"`;
        if (s.expression) return `(${s.expression}) AS "${s.alias}"`;
        if (s.column) return s.column;
        return '*';
    }

    private static whereToSql(w: any): string {
        if (w.expression) return w.expression;
        const op = this.mapOp(w.operator);
        return `"${w.column}" ${op} ${op === 'IS NULL' ? '' : w.value}`;
    }

    private static mapOp(op: string): string {
        const map: any = { 'EQ': '=', 'LT': '<', 'GT': '>', 'NEQ': '!=', 'IS_NULL': 'IS NULL' };
        return map[op] || op;
    }
}
