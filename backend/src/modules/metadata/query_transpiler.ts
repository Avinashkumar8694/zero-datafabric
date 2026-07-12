/**
 * AST-to-SQL transpiler for view/materialized-view definitions.
 * ---------------------------------------------------------------
 * Converts the engine-agnostic `QueryAST` (see `types.ts`) declared in a
 * manifest's VIEW/MATERIALIZED_VIEW resources into Postgres SQL text. Handles
 * recursive CTEs (`WITH RECURSIVE`), joins, window functions, aggregates,
 * basic full-text search predicates and set operations (UNION/INTERSECT/EXCEPT).
 * Used by `Transpiler.toSql` when emitting `CREATE VIEW`/`CREATE MATERIALIZED VIEW`
 * statements.
 */
import { QueryAST } from './types';

/**
 * Stateless AST→SQL compiler for `QueryAST` view definitions.
 * @class
 * @hideconstructor
 */
export class QueryTranspiler {
    /**
     * Compiles a `QueryAST` into a single SQL SELECT statement (or a set
     * operation combining several). Recurses into CTEs, set-operation branches
     * and JOIN targets, threading the current schema prefix and the set of
     * locally-defined CTE names so unqualified references to those names are
     * not re-qualified with `schemaPrefix`.
     * @param ast The query AST to compile.
     * @param schemaPrefix Physical schema to qualify bare resource/column references with (omitted for CTE-local references).
     * @param localCtes CTE names already in scope from an enclosing `WITH` clause; used internally for recursive compilation and defaults to an empty set at the top level.
     * @returns The compiled SQL text (trimmed, no trailing semicolon).
     */
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

    /**
     * Compiles a single SELECT-list entry: a bare column name/path, a raw
     * `expression`, a window function call, an aggregate call, or a
     * `(column, alias)` reference.
     * @param c The select-list entry (string, or one of the object shapes above).
     * @param schemaPrefix Physical schema used to qualify bare column references.
     * @returns The compiled column expression, including an `AS "alias"` suffix when an alias is given.
     */
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

    /**
     * Compiles a single WHERE-clause predicate: a raw `expression`, a
     * full-text `search` predicate (`to_tsvector`/`plainto_tsquery`), or a
     * `(column, operator, value)` comparison.
     * @param w The predicate entry.
     * @param schemaPrefix Physical schema used to qualify bare column references.
     * @returns The compiled boolean SQL condition (without surrounding `AND`/`WHERE`).
     */
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

    /**
     * Quotes a bare identifier path for safe use in generated SQL, leaving
     * `*`, already dotted paths (e.g. `alias.column`), and paths compiled
     * with no `schemaPrefix` untouched.
     * @param path Column name or alias-qualified path (e.g. `"col"` or `"t.col"`).
     * @param schemaPrefix Physical schema in scope; when absent, bare identifiers are left unquoted (e.g. CTE-local references).
     * @returns The identifier, double-quoted when it should be qualified as an owned column.
     */
    private static qualify(path: string, schemaPrefix?: string): string {
        if (!path || path === '*') return path;
        if (path.includes('.') || !schemaPrefix) return path;
        return `"${path}"`;
    }

    /**
     * Maps a canonical AST comparison operator token (e.g. `EQ`, `IS_NULL`) to
     * its SQL operator/keyword. Unknown tokens pass through unchanged so
     * callers may already supply raw SQL operators.
     * @param op Canonical operator token from the AST.
     * @returns The SQL operator or keyword to emit.
     */
    private static mapOp(op: string): string {
        const map: any = {
            'EQ': '=', 'NE': '!=', 'GT': '>', 'LT': '<', 'GTE': '>=', 'LTE': '<=',
            'LIKE': 'LIKE', 'ILIKE': 'ILIKE', 'IN': 'IN', 'IS_NULL': 'IS NULL', 'IS_NOT_NULL': 'IS NOT NULL'
        };
        return map[op] || op;
    }
}
