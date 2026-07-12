/**
 * Fabric DDL / AST renderer.
 *
 * The Data Fabric presents every federated resource — a Postgres table, a Mongo
 * collection, an Elasticsearch index, a Snowflake table, a view, function,
 * sequence, enum or trigger — through ONE unified relational model. This module
 * produces that unified view in two forms for the Discovery Catalog / API:
 *
 *   - a **datafabric-format SQL DDL** (a `CREATE …` statement reconstructed from
 *     the catalog metadata, annotated with the physical engine), and
 *   - a **Fabric AST** (the fabric's own canonical JSON descriptor of the
 *     resource, including a ready-to-run query/CALL AST).
 *
 * When a manifest already supplied a logical AST or real DDL we keep it; when the
 * resource was discovered by crawling a source (so no manifest exists) we
 * synthesize both from the discovered columns/definition. This guarantees the
 * catalog never falls back to a meaningless `SELECT * FROM x` placeholder.
 */

/** A normalized catalog column (as produced by normalizeAstColumn / live discovery). */
export interface FabricColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  default?: any;
  strategy?: string | null;
}

/** The catalog resource row plus its resolved columns. */
export interface ResourceInput {
  name: string;
  physicalName: string;
  resourceType: string;
  schemaName?: string;
  sourceName?: string;
  sourceType?: string;          // engine, e.g. POSTGRES / MONGODB / ELASTICSEARCH
  definitionSql?: string | null;
  definitionAst?: any;
  columns?: FabricColumn[];
}

/** Quote a SQL identifier for the fabric-canonical DDL. */
function q(id: string): string {
  return '"' + String(id ?? '').replace(/"/g, '') + '"';
}

/**
 * Map a discovered/loose column type to a canonical fabric SQL type. Postgres-style
 * types pass through (upper-cased); loose engine types (Mongo `number`/`object`,
 * ES `keyword`/`text`) map onto the fabric's relational type vocabulary.
 *
 * @param raw - the discovered type string (may be undefined).
 * @returns a canonical uppercase SQL type token.
 */
export function canonicalType(raw?: string): string {
  const t = String(raw || '').trim().toLowerCase();
  if (!t || t === 'null' || t === 'undefined' || t === 'none') return 'TEXT'; // unknown/sampled-null → default
  if (/^(bigint|int8|serial8|bigserial)/.test(t)) return 'BIGINT';
  if (/^(smallint|int2)/.test(t)) return 'SMALLINT';
  if (/(^|\b)(int|integer|int4|serial|long)/.test(t)) return 'INTEGER';
  if (/(numeric|decimal|double|float|real|money|number)/.test(t)) return 'NUMERIC';
  if (/(bool)/.test(t)) return 'BOOLEAN';
  if (/(timestamp|datetime)/.test(t)) return 'TIMESTAMP';
  if (/(^|\b)date/.test(t)) return 'DATE';
  if (/(^|\b)time/.test(t)) return 'TIME';
  if (/(uuid)/.test(t)) return 'UUID';
  if (/(json|object|array|nested|map)/.test(t)) return 'JSONB';
  if (/(char|text|string|keyword|varchar)/.test(t)) return 'TEXT';
  // preserve an already-SQL-looking type (e.g. VARCHAR(255)), else fall back to TEXT
  return /^[a-z][a-z0-9_]*(\(\d+(,\d+)?\))?$/.test(t) ? t.toUpperCase() : 'TEXT';
}

/** Column list projected from either explicit columns or the manifest AST. */
function columnsOf(r: ResourceInput): FabricColumn[] {
  if (Array.isArray(r.columns) && r.columns.length) return r.columns;
  if (r.definitionAst && Array.isArray(r.definitionAst.columns)) return r.definitionAst.columns;
  return [];
}

/**
 * Build the fabric-canonical SQL DDL for a resource. Always returns a real
 * `CREATE …` statement (never a `SELECT` placeholder), prefaced with the engine
 * provenance so it is clear this is the fabric's unified relational projection.
 *
 * @param r - the resource row plus resolved columns.
 * @returns a DDL string in datafabric format.
 */
export function renderFabricDdl(r: ResourceInput): string {
  const engine = String(r.sourceType || 'POSTGRES').toUpperCase();
  const schema = r.schemaName || 'public';
  const header =
    `-- Fabric canonical DDL — unified relational projection of a federated resource\n` +
    `-- source: ${r.sourceName || 'Fabric'}   engine: ${engine}   schema: ${schema}\n\n`;
  const type = String(r.resourceType || 'TABLE').toUpperCase();
  const fq = `${q(schema)}.${q(r.physicalName || r.name)}`;
  const a = r.definitionAst || {};
  const notCaptured = `-- definition not captured — crawl the source (POST /api/metadata/crawl)`;

  if (type.includes('VIEW')) {
    const mat = type.includes('MATERIALIZED') ? 'MATERIALIZED VIEW' : 'VIEW';
    // Prefer the introspected/manifest SELECT; a canonical query object is left to
    // the Fabric AST tab (indented raw SQL is what belongs in a CREATE VIEW).
    const query = typeof a.query === 'string' && a.query.trim()
      ? a.query.trim().replace(/;+\s*$/, '')
      : (r.definitionSql && String(r.definitionSql).trim() ? String(r.definitionSql).trim().replace(/;+\s*$/, '') : null);
    const body = query ? query.split('\n').map((l: string) => '  ' + l).join('\n') : `  ${notCaptured}\n  SELECT * FROM ${fq}`;
    return `${header}CREATE ${mat} ${fq} AS\n${body};`;
  }

  if (type === 'FUNCTION' || type === 'PROCEDURE') {
    // argsText comes from pg_get_function_arguments (authoritative); else rebuild from a typed list.
    const args = typeof a.argsText === 'string' ? a.argsText
      : (Array.isArray(a.arguments) ? a.arguments.map((x: any) => `${x.name || 'arg'} ${canonicalType(x.type)}`).join(', ') : '');
    const ret = a.returnType || (a.returns ? canonicalType(a.returns) : 'record');
    const body = a.body && String(a.body).trim() ? String(a.body).trim() : notCaptured;
    const retClause = type === 'FUNCTION' ? `\n  RETURNS ${ret}` : '';
    const lang = a.language || 'plpgsql';
    return `${header}CREATE ${type} ${fq}(${args})${retClause}\n  LANGUAGE ${lang}\nAS $$\n${body}\n$$;`;
  }

  if (type === 'SEQUENCE') {
    const hasVals = a.start != null || a.increment != null;
    return `${header}CREATE SEQUENCE ${fq}\n  START WITH ${a.start ?? 1}\n  INCREMENT BY ${a.increment ?? 1}` +
      (a.minValue != null ? `\n  MINVALUE ${a.minValue}` : '') +
      (a.maxValue != null ? `\n  MAXVALUE ${a.maxValue}` : '') +
      `\n  ${a.cache ? `CACHE ${a.cache}` : 'NO CACHE'};` +
      (hasVals ? '' : `\n${notCaptured}`);
  }

  if (type === 'ENUM') {
    const vals = (a.values || []).map((v: string) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
    return `${header}CREATE TYPE ${fq} AS ENUM (${vals});` + (vals ? '' : `\n${notCaptured}`);
  }

  if (type === 'TRIGGER') {
    // pg_get_triggerdef is authoritative — present it under the fabric header.
    if (a.triggerDef || (r.definitionSql && /CREATE\s+TRIGGER/i.test(String(r.definitionSql)))) {
      return `${header}${String(a.triggerDef || r.definitionSql).trim()};`.replace(/;;$/, ';');
    }
    return `${header}CREATE TRIGGER ${q(r.name)}\n  ${a.timing || 'AFTER'} ${a.event || 'INSERT'} ON ${q(a.table || r.physicalName)}\n  FOR EACH ${a.level || 'ROW'}\n  EXECUTE FUNCTION ${a.function || 'fabric_trigger_fn'}();\n${notCaptured}`;
  }

  // Default: TABLE / FOREIGN_TABLE / collection / index → CREATE TABLE from columns.
  const cols = columnsOf(r);
  if (!cols.length) {
    return `${header}CREATE TABLE ${fq} (\n  -- column metadata not yet crawled; run POST /api/metadata/crawl\n);`;
  }
  const width = Math.min(28, Math.max(...cols.map((c) => (c.name || '').length)) + 2);
  const lines = cols.map((c) => {
    const nm = q(c.name).padEnd(width + 2);
    const ty = canonicalType(c.type);
    const nn = c.nullable === false ? ' NOT NULL' : '';
    const dflt = c.default != null && c.default !== '' ? ` DEFAULT ${typeof c.default === 'string' ? c.default : JSON.stringify(c.default)}` : '';
    return `  ${nm}${ty}${nn}${dflt}`;
  });
  const pks = cols.filter((c) => c.primaryKey).map((c) => q(c.name));
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  const note = engine !== 'POSTGRES' ? `\n-- NOTE: physically a ${engine} ${engine === 'MONGODB' ? 'collection' : 'index/table'}; the fabric exposes it relationally.` : '';
  return `${header}CREATE TABLE ${fq} (\n${lines.join(',\n')}\n);${note}`;
}

/**
 * Build the Fabric AST — the fabric's canonical JSON descriptor of a resource,
 * including a runnable query/CALL AST. If a manifest logical AST exists it is
 * preserved and enriched; otherwise one is synthesized from the columns.
 *
 * @param r - the resource row plus resolved columns.
 * @returns a plain object (the Fabric AST) suitable for JSON display / reuse.
 */
export function renderFabricAst(r: ResourceInput): any {
  const engine = String(r.sourceType || 'POSTGRES').toUpperCase();
  const type = String(r.resourceType || 'TABLE').toUpperCase();
  const cols = columnsOf(r);
  const base: any = {
    kind: type,
    resource: r.name,
    physicalName: r.physicalName,
    source: r.sourceName,
    engine,
    schema: r.schemaName,
  };

  // Attach the logical definition (manifest-supplied OR live-introspected).
  const hasDef = r.definitionAst && typeof r.definitionAst === 'object' && Object.keys(r.definitionAst).length;
  if (hasDef) base.definition = r.definitionAst;

  if (type === 'FUNCTION' || type === 'PROCEDURE') {
    // Always expose a runnable CALL AST alongside the definition.
    base.invoke = { type: 'CALL', [type === 'PROCEDURE' ? 'procedure' : 'function']: r.name, schema: r.schemaName, args: [] };
    return base;
  }
  if (type === 'SEQUENCE' || type === 'ENUM' || type === 'TRIGGER') {
    return base; // definition (if introspected) + provenance
  }

  // TABLE / VIEW / collection / index → columns + a ready-to-run fabric SELECT AST.
  if (cols.length) base.columns = cols;
  base.query = {
    from: { resource: r.name, source: r.sourceName },
    select: cols.length ? cols.map((c) => c.name) : ['*'],
  };
  return base;
}
