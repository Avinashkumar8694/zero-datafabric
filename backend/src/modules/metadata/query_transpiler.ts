import { QueryAST } from './types';

export class QueryTranspiler {
    static toSql(ast: QueryAST, schemaPrefix?: string, localCtes: Set<string> = new Set()): string {
        let sql = '';

        // 1. Set Operations (UNION, INTERSECT, EXCEPT)
        if (ast.union || ast.intersect || ast.except) {
            const parts: string[] = [];
            const sets = ast.union ? { op: 'UNION', items: ast.union } : 
                         ast.intersect ? { op: 'INTERSECT', items: ast.intersect } : 
                         { op: 'EXCEPT', items: ast.except! };

            for (const item of sets.items) {
                parts.push(`(${this.toSql(item, schemaPrefix, localCtes)})`);
            }
            return parts.join(` ${sets.op} `);
        }

        // 2. WITH Clause
        const updatedLocalCtes = new Set(localCtes);
        if (ast.with) {
            const ctes = ast.with.map(cte => {
                updatedLocalCtes.add(cte.name);
                const baseSql = this.toSql(cte.base, schemaPrefix, updatedLocalCtes);
                let cteSql = `"${cte.name}"(${cte.columns.join(', ')}) AS (${baseSql}`;
                if (cte.unionAll) {
                    cteSql += ` UNION ALL ${this.toSql(cte.unionAll, schemaPrefix, updatedLocalCtes)}`;
                }
                cteSql += ')';
                return cteSql;
            }).join(', ');
            sql += `WITH RECURSIVE ${ctes} `;
        }

        // 3. SELECT
        const selectCols = ast.select?.map(c => this.columnToSql(c, schemaPrefix)).join(', ') || '*';
        sql += `SELECT ${selectCols} `;

        // 4. FROM
        const isLocal = updatedLocalCtes.has(ast.from.resource);
        const fromResource = ast.from.source ? `${ast.from.source}.${ast.from.resource}` : 
                            (isLocal ? `"${ast.from.resource}"` : (schemaPrefix ? `"${schemaPrefix}"."${ast.from.resource}"` : `"${ast.from.resource}"`));
        sql += `FROM ${fromResource} ${ast.from.alias ? `AS "${ast.from.alias}"` : ''} `;

        // 5. JOINS
        if (ast.joins) {
            for (const join of ast.joins) {
                const isJoinLocal = updatedLocalCtes.has(join.resource);
                const joinResource = isJoinLocal ? `"${join.resource}"` : (schemaPrefix ? `"${schemaPrefix}"."${join.resource}"` : `"${join.resource}"`);
                const joinType = join.type || 'INNER';
                sql += `${joinType} JOIN ${joinResource} ${join.alias ? `AS "${join.alias}"` : ''} `;
                sql += `ON ${this.qualify(join.on.left, schemaPrefix)} ${this.mapOp(join.on.operator)} ${this.qualify(join.on.right, schemaPrefix)} `;
            }
        }

        // 6. WHERE
        if (ast.where && ast.where.length > 0) {
            const conditions = ast.where.map(w => this.whereToSql(w, schemaPrefix)).join(' AND ');
            sql += `WHERE ${conditions} `;
        }

        // 7. GROUP BY
        if (ast.groupBy) {
            sql += `GROUP BY ${ast.groupBy.map(g => this.qualify(g, schemaPrefix)).join(', ')} `;
        }

        // 8. ORDER BY
        if (ast.orderBy) {
            const orders = ast.orderBy.map(o => `${this.qualify(o.column, schemaPrefix)} ${o.direction}`).join(', ');
            sql += `ORDER BY ${orders} `;
        }

        return sql.trim();
    }

    private static columnToSql(c: any, schemaPrefix?: string): string {
        if (typeof c === 'string') return this.qualify(c, schemaPrefix);
        if (c.expression) return `${c.expression}${c.alias ? ` AS "${c.alias}"` : ''}`;
        
        // Window Functions
        if (c.window) {
            let winSql = `${c.window}() OVER (`;
            if (c.partitionBy) winSql += `PARTITION BY ${c.partitionBy.map((p: string) => this.qualify(p, schemaPrefix)).join(', ')} `;
            if (c.orderBy) winSql += `ORDER BY ${c.orderBy.map((o: any) => `${this.qualify(o.column, schemaPrefix)} ${o.direction}`).join(', ')}`;
            winSql += `)${c.alias ? ` AS "${c.alias}"` : ''}`;
            return winSql;
        }

        // Aggregates
        if (c.aggregate) {
            const col = c.column ? this.qualify(c.column, schemaPrefix) : '*';
            return `${c.aggregate}(${col})${c.alias ? ` AS "${c.alias}"` : ''}`;
        }

        if (c.column) return `${this.qualify(c.column, schemaPrefix)}${c.alias ? ` AS "${c.alias}"` : ''}`;
        return '';
    }

    private static whereToSql(w: any, schemaPrefix?: string): string {
        if (w.expression) return w.expression;
        
        // Full Text Search
        if (w.search) {
            return `to_tsvector('english', ${this.qualify(w.search.column, schemaPrefix)}) @@ plainto_tsquery('english', '${w.search.query}')`;
        }

        const op = this.mapOp(w.operator);
        const col = this.qualify(w.column, schemaPrefix);
        return `${col} ${op} ${op === 'IS NULL' || op === 'IS NOT NULL' ? '' : `'${w.value}'`}`;
    }

    private static qualify(path: string, schemaPrefix?: string): string {
        if (!path || path === '*') return path;
        if (path.includes('.') || !schemaPrefix) return path;
        return `"${path}"`;
    }

    private static mapOp(op: string): string {
        const map: any = {
            'EQ': '=', 'NE': '!=', 'GT': '>', 'LT': '<', 'GTE': '>=', 'LTE': '<=',
            'LIKE': 'LIKE', 'ILIKE': 'ILIKE', 'IN': 'IN', 'IS_NULL': 'IS NULL', 'IS_NOT_NULL': 'IS NOT NULL'
        };
        return map[op] || op;
    }
}
