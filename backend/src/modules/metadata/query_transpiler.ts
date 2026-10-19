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
import { assertIdent } from '../../utils/identifiers';

/**
 * This transpiler escapes every literal value itself (single quotes doubled, NUL rejected), validates every
 * identifier/path/operator/aggregate/window name, and refuses raw `expression` fragments containing statement
 * separators, comments or dollar quoting. Callers must NOT pre-escape values (`escapeAstLiterals`) when this is true.
 */
export const transpilerEscapesValues = true;

const SOURCE_RE = /^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$/;
const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'STDDEV', 'VARIANCE', 'ARRAY_AGG', 'BOOL_AND', 'BOOL_OR', 'COUNT_DISTINCT']);
const WINDOWS = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST']);
const JOIN_TYPES = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS']);

function ident(v: unknown, what: string): string { return assertIdent(v, what); }

/** `a`, `a.b` or `a.*`: every segment a plain identifier. Returns the path unchanged. */
function pathOf(v: unknown, what: string): string {
    if (typeof v !== 'string') throw Object.assign(new Error(`Invalid ${what}`), { status: 400, code: 'INVALID_IDENTIFIER' });
    if (v === '*') return v;
    const parts = v.split('.');
    if (parts.length > 3) throw Object.assign(new Error(`Invalid ${what}`), { status: 400, code: 'INVALID_IDENTIFIER' });
    parts.forEach((p, i) => { if (!(p === '*' && i === parts.length - 1 && parts.length > 1)) assertIdent(p, what); });
    return v;
}

function literal(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return `(${v.map((x) => literal(x)).join(', ')})`;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.includes('\0')) throw Object.assign(new Error('Invalid value: NUL bytes are not allowed'), { status: 400, code: 'INVALID_VALUE' });
    return `'${s.replace(/'/g, "''")}'`;
}

/** Raw `expression` entries are free SQL (gated by the caller); keep them to a single statement fragment. */
function fragment(v: unknown, what: string): string {
    const s = String(v ?? '');
    if (!s.trim() || s.includes('\0') || s.includes(';') || /--|\/\*|\*\/|\$[A-Za-z0-9_]*\$/.test(s)) {
        throw Object.assign(new Error(`Invalid ${what}: contains a forbidden character sequence`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
    }
    return s;
}

/** LIMIT / OFFSET operand: a non-negative integer (numeric strings accepted), never free text. */
function nonNegInt(v: unknown, what: string): number {
    const n = typeof v === 'string' && /^\d{1,12}$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000_000) throw Object.assign(new Error(`Invalid ${what}: must be an integer between 0 and 1000000000`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
    return n;
}

function dir(d: unknown): string {
    const x = String(d ?? 'ASC').toUpperCase();
    if (x !== 'ASC' && x !== 'DESC') throw Object.assign(new Error('Invalid sort direction'), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
    return x;
}

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
            let setSql = parts.join(` ${sets.op} `);
            if (ast.orderBy && ast.orderBy.length) setSql += ` ORDER BY ${ast.orderBy.map(o => `${this.qualify(o.column, undefined)} ${dir(o.direction)}`).join(', ')}`;
            if (ast.limit !== undefined && ast.limit !== null) setSql += ` LIMIT ${nonNegInt(ast.limit, 'limit')}`;
            if (ast.offset !== undefined && ast.offset !== null && Number(ast.offset) > 0) setSql += ` OFFSET ${nonNegInt(ast.offset, 'offset')}`;
            return setSql;
        }

        // 2. WITH Clause
        const updatedLocalCtes = new Set(localCtes);
        if (ast.with) {
            const ctes = ast.with.map(cte => {
                ident(cte.name, 'with.name');
                updatedLocalCtes.add(cte.name);
                const baseSql = this.toSql(cte.base, schemaPrefix, updatedLocalCtes);
                let cteSql = `"${cte.name}"(${(cte.columns || []).map((c: string) => `"${ident(c, 'with.columns')}"`).join(', ')}) AS (${baseSql}`;
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
        sql += `SELECT ${ast.distinct ? 'DISTINCT ' : ''}${selectCols} `;

        // 4. FROM
        if (schemaPrefix !== undefined) ident(schemaPrefix, 'schema');
        if ((ast.from as any).query) {
            // Derived table: FROM (<subselect>) AS alias. An alias is mandatory in Postgres.
            if (!ast.from.alias) throw Object.assign(new Error('A derived-table subquery in FROM needs an alias'), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
            sql += `FROM (${this.toSql((ast.from as any).query, schemaPrefix, updatedLocalCtes)}) AS "${ident(ast.from.alias, 'from.alias')}" `;
        } else {
        ident(ast.from.resource, 'from.resource');
        if (ast.from.source !== undefined && ast.from.source !== null && !SOURCE_RE.test(String(ast.from.source))) throw Object.assign(new Error('Invalid from.source'), { status: 400, code: 'INVALID_IDENTIFIER' });
        const isLocal = updatedLocalCtes.has(ast.from.resource);
        const fromResource = ast.from.source ? `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(ast.from.source)) ? ast.from.source : `"${ast.from.source}"`}.${ast.from.resource}` : 
                            (isLocal ? `"${ast.from.resource}"` : (schemaPrefix ? `"${schemaPrefix}"."${ast.from.resource}"` : `"${ast.from.resource}"`));
        sql += `FROM ${fromResource} ${ast.from.alias ? `AS "${ident(ast.from.alias, 'from.alias')}"` : ''} `;
        }

        // 5. JOINS
        if (ast.joins) {
            for (const join of ast.joins) {
                ident(join.resource, 'join.resource');
                const isJoinLocal = updatedLocalCtes.has(join.resource);
                const joinResource = isJoinLocal ? `"${join.resource}"` : (schemaPrefix ? `"${schemaPrefix}"."${join.resource}"` : `"${join.resource}"`);
                const joinType = String(join.type || 'INNER').toUpperCase();
                if (!JOIN_TYPES.has(joinType)) throw Object.assign(new Error('Invalid join.type'), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
                sql += `${joinType} JOIN ${joinResource} ${join.alias ? `AS "${ident(join.alias, 'join.alias')}"` : ''} `;
                sql += `ON ${this.qualify(join.on.left, schemaPrefix)} ${this.mapOp(join.on.operator)} ${this.qualify(join.on.right, schemaPrefix)} `;
            }
        }

        // 6. WHERE
        if (ast.where && ast.where.length > 0) {
            const conditions = ast.where.map(w => this.whereToSql(w, schemaPrefix)).join(' AND ');
            sql += `WHERE ${conditions} `;
        }

        // 7. GROUP BY
        if (ast.groupBy && ast.groupBy.length) {
            sql += `GROUP BY ${ast.groupBy.map(g => this.qualify(g, schemaPrefix)).join(', ')} `;
        }

        // 7b. HAVING: `column` names a select alias (resolved to its aggregate expression) or a grouped column.
        const having = (ast as any).having;
        if (Array.isArray(having) && having.length > 0) {
            sql += `HAVING ${having.map((h: any) => this.havingToSql(h, ast.select, schemaPrefix)).join(' AND ')} `;
        }

        // 8. ORDER BY
        if (ast.orderBy && ast.orderBy.length) {
            const orders = ast.orderBy.map(o => `${this.qualify(o.column, schemaPrefix)} ${dir(o.direction)}`).join(', ');
            sql += `ORDER BY ${orders} `;
        }

        // 9. LIMIT / OFFSET
        const lim = (ast as any).limit; const off = (ast as any).offset;
        if (lim !== undefined && lim !== null) sql += `LIMIT ${nonNegInt(lim, 'limit')} `;
        if (off !== undefined && off !== null && Number(off) > 0) sql += `OFFSET ${nonNegInt(off, 'offset')} `;

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
        if (c.expression) return `${fragment(c.expression, 'select.expression')}${c.alias ? ` AS "${ident(c.alias, 'select.alias')}"` : ''}`;
        
        // Window Functions
        if (c.window) {
            const win = String(c.window).toUpperCase();
            if (!WINDOWS.has(win)) throw Object.assign(new Error(`Invalid window function "${String(c.window).slice(0, 20)}"`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
            let winSql = `${win}() OVER (`;
            if (c.partitionBy) winSql += `PARTITION BY ${c.partitionBy.map((p: string) => this.qualify(p, schemaPrefix)).join(', ')} `;
            if (c.orderBy) winSql += `ORDER BY ${c.orderBy.map((o: any) => `${this.qualify(o.column, schemaPrefix)} ${dir(o.direction)}`).join(', ')}`;
            winSql += `)${c.alias ? ` AS "${ident(c.alias, 'select.alias')}"` : ''}`;
            return winSql;
        }

        // Aggregates
        if (c.aggregate) {
            const agg = String(c.aggregate).toUpperCase();
            if (!AGGREGATES.has(agg)) throw Object.assign(new Error(`Invalid aggregate "${String(c.aggregate).slice(0, 20)}"`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
            return `${this.aggregateExpr(c, schemaPrefix)}${c.alias ? ` AS "${ident(c.alias, 'select.alias')}"` : ''}`;
        }

        if (c.column) return `${this.qualify(c.column, schemaPrefix)}${c.alias ? ` AS "${ident(c.alias, 'select.alias')}"` : ''}`;
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
        if (w.expression) return fragment(w.expression, 'where.expression');
        
        // Full Text Search
        if (w.search) {
            return `to_tsvector('english', ${this.qualify(w.search.column, schemaPrefix)}) @@ plainto_tsquery('english', ${literal(String(w.search.query ?? ''))})`;
        }

        return this.comparison(w, schemaPrefix);
    }

    /** `column OP literal` with SQL-correct NULL handling: `EQ null` -> IS NULL, `NE null` -> IS NOT NULL, empty IN -> false, empty NOT IN -> true. */
    private static comparison(w: any, schemaPrefix?: string): string {
        const op = this.mapOp(w.operator);
        const col = this.qualify(w.column, schemaPrefix);
        if (op === 'IS NULL' || op === 'IS NOT NULL') return `${col} ${op}`;
        if ((w.value === null || w.value === undefined) && (op === '=' || op === '!=' || op === '<>')) return `${col} IS ${op === '=' ? '' : 'NOT '}NULL`;
        if (op === 'IN' || op === 'NOT IN') {
            const arr = Array.isArray(w.value) ? w.value : [w.value];
            if (arr.length === 0) return op === 'IN' ? '1 = 0' : '1 = 1';
            return `${col} ${op} ${literal(arr)}`;
        }
        return `${col} ${op} ${literal(w.value)}`;
    }

    /** The aggregate call text (`COUNT(*)`, `SUM("a")`, `COUNT(DISTINCT "a")`) of a select entry. */
    private static aggregateExpr(c: any, schemaPrefix?: string): string {
        const agg = String(c.aggregate).toUpperCase();
        if (!AGGREGATES.has(agg)) throw Object.assign(new Error(`Invalid aggregate "${String(c.aggregate).slice(0, 20)}"`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
        const col = c.column ? this.qualify(c.column, schemaPrefix) : '*';
        return agg === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${col})` : `${agg}(${col})`;
    }

    /** One HAVING predicate. A bare name that matches a select alias is replaced by that entry's aggregate expression. */
    private static havingToSql(h: any, select: any[] | undefined, schemaPrefix?: string): string {
        const hit = Array.isArray(select) ? select.find((c: any) => c && typeof c === 'object' && c.aggregate && c.alias === h.column) : undefined;
        if (hit) {
            const op = this.mapOp(h.operator || 'EQ');
            if (op === 'IS NULL' || op === 'IS NOT NULL') return `${this.aggregateExpr(hit, schemaPrefix)} ${op}`;
            return `${this.aggregateExpr(hit, schemaPrefix)} ${op} ${literal(h.value)}`;
        }
        return this.comparison({ ...h, operator: h.operator || 'EQ' }, schemaPrefix);
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
        pathOf(path, 'column');
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
            'EQ': '=', 'NE': '!=', 'NEQ': '!=', 'GT': '>', 'LT': '<', 'GTE': '>=', 'LTE': '<=',
            'LIKE': 'LIKE', 'ILIKE': 'ILIKE', 'IN': 'IN', 'NIN': 'NOT IN', 'NOT_IN': 'NOT IN', 'NOT_LIKE': 'NOT LIKE', 'IS_NULL': 'IS NULL', 'IS_NOT_NULL': 'IS NOT NULL',
            '=': '=', '!=': '!=', '<>': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=',
        };
        const key = String(op ?? '').toUpperCase();
        const mapped = map[key];
        if (!mapped) throw Object.assign(new Error(`Unsupported operator "${String(op).slice(0, 20)}"`), { status: 400, code: 'INVALID_SQL_FRAGMENT' });
        return mapped;
    }
}
