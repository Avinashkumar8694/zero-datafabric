/**
 * DestOps — per-engine destination write primitives shared by replication and CDC apply.
 *
 * Every destination engine needs the same three idempotent operations:
 *   • ensure(schema, table, cols, pk, fresh) — create the target (drop first if `fresh`)
 *   • upsert(schema, table, cols, pk, rows)   — insert-or-update by primary key
 *   • del(schema, table, pk, pkValue)          — delete one row/doc by primary key (CDC delete)
 *
 * Implemented for PostgreSQL, MySQL, Oracle (SQL: ON CONFLICT / ON DUPLICATE KEY / MERGE),
 * MongoDB (bulk replaceOne upsert / deleteOne) and Elasticsearch (_bulk index / delete _doc).
 * Upsert-by-PK makes every apply idempotent → safe to replay (resume, CDC redelivery).
 */
import { canonicalType } from '../metadata/ddl_render';

export type DestKind = 'PG' | 'MYSQL' | 'ORACLE' | 'MONGO' | 'ES';

export function destKindOf(engine: string): DestKind | null {
  const e = String(engine).toUpperCase();
  if (['POSTGRES', 'POSTGRESQL'].includes(e)) return 'PG';
  if (e === 'MYSQL') return 'MYSQL';
  if (['ORACLE', 'ORACLEDB'].includes(e)) return 'ORACLE';
  if (['MONGODB', 'MONGO'].includes(e)) return 'MONGO';
  if (['ELASTICSEARCH', 'ELASTIC', 'ES'].includes(e)) return 'ES';
  return null;
}

const pgq = (id: string) => '"' + String(id).replace(/"/g, '') + '"';
const myq = (id: string) => '`' + String(id).replace(/`/g, '') + '`';
const orq = (id: string) => '"' + String(id).replace(/"/g, '').toUpperCase() + '"';
const jsonSafe = (v: any) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v === undefined ? null : v);

/** Fabric-canonical → MySQL column type (PK text cols become VARCHAR so they're indexable). */
function mysqlType(canonical: string, isPk: boolean): string {
  const t = String(canonical).toUpperCase();
  if (/BIGINT/.test(t)) return 'BIGINT';
  if (/SMALLINT/.test(t)) return 'SMALLINT';
  if (/INT/.test(t)) return 'INT';
  if (/NUMERIC|DECIMAL|DOUBLE|REAL|FLOAT/.test(t)) return 'DOUBLE';
  if (/BOOL/.test(t)) return 'TINYINT(1)';
  if (/TIMESTAMP|DATETIME/.test(t)) return 'DATETIME';
  if (/DATE/.test(t)) return 'DATE';
  if (/JSON/.test(t)) return 'JSON';
  if (/BYTEA|BLOB|BINARY/.test(t)) return 'BLOB';
  if (/UUID/.test(t)) return 'CHAR(36)';
  return isPk ? 'VARCHAR(255)' : 'TEXT';
}
/** Fabric-canonical → Oracle column type. */
function oracleType(canonical: string): string {
  const t = String(canonical).toUpperCase();
  if (/BIGINT|SMALLINT|INT|NUMERIC|DECIMAL|DOUBLE|REAL|FLOAT/.test(t)) return 'NUMBER';
  if (/BOOL/.test(t)) return 'NUMBER(1)';
  if (/TIMESTAMP|DATETIME/.test(t)) return 'TIMESTAMP';
  if (/DATE/.test(t)) return 'DATE';
  if (/CLOB|JSON/.test(t)) return 'CLOB';
  if (/BYTEA|BLOB|BINARY/.test(t)) return 'BLOB';
  return 'VARCHAR2(4000)';
}

export class DestOps {
  /** Create the target table/collection/index (drop first when `fresh`). */
  static async ensure(kind: DestKind, w: any, schema: string, table: string, cols: any[], pkCols: string[], fresh: boolean): Promise<void> {
    if (kind === 'PG') {
      const defs = cols.map((c) => `${pgq(c.name)} ${canonicalType(c.type)}`);
      const pk = pkCols.length ? `, PRIMARY KEY (${pkCols.map(pgq).join(', ')})` : '';
      await w.rawQuery(`CREATE SCHEMA IF NOT EXISTS ${pgq(schema)}`);
      if (fresh) { await w.rawQuery(`DROP TABLE IF EXISTS ${pgq(schema)}.${pgq(table)}`); await w.rawQuery(`CREATE TABLE ${pgq(schema)}.${pgq(table)} (${defs.join(', ')}${pk})`); }
      else await w.rawQuery(`CREATE TABLE IF NOT EXISTS ${pgq(schema)}.${pgq(table)} (${defs.join(', ')}${pk})`);
    } else if (kind === 'MYSQL') {
      const defs = cols.map((c) => `${myq(c.name)} ${mysqlType(canonicalType(c.type), pkCols.includes(c.name))}`);
      const pk = pkCols.length ? `, PRIMARY KEY (${pkCols.map(myq).join(', ')})` : '';
      await w.rawQuery(`CREATE DATABASE IF NOT EXISTS ${myq(schema)}`);
      if (fresh) { await w.rawQuery(`DROP TABLE IF EXISTS ${myq(schema)}.${myq(table)}`); await w.rawQuery(`CREATE TABLE ${myq(schema)}.${myq(table)} (${defs.join(', ')}${pk})`); }
      else await w.rawQuery(`CREATE TABLE IF NOT EXISTS ${myq(schema)}.${myq(table)} (${defs.join(', ')}${pk})`);
    } else if (kind === 'ORACLE') {
      // Oracle has no CREATE TABLE IF NOT EXISTS / DROP IF EXISTS — probe + swallow ORA-00942/00955.
      const defs = cols.map((c) => `${orq(c.name)} ${oracleType(canonicalType(c.type))}`);
      const pk = pkCols.length ? `, CONSTRAINT ${orq(table + '_pk')} PRIMARY KEY (${pkCols.map(orq).join(', ')})` : '';
      if (fresh) { try { await w.rawQuery(`DROP TABLE ${orq(table)} CASCADE CONSTRAINTS`); } catch { /* ORA-00942: not there */ } }
      try { await w.rawQuery(`CREATE TABLE ${orq(table)} (${defs.join(', ')}${pk})`); } catch (e: any) { if (!/ORA-00955/.test(e.message)) throw e; /* already exists */ }
    } else if (kind === 'MONGO') {
      if (fresh) await w.clearCollection(schema, table);
    } else if (kind === 'ES') {
      if (fresh) await w.dropIndex(table);   // `table` is the ES index name
    }
  }

  /** Insert-or-update a batch of rows by primary key. */
  static async upsert(kind: DestKind, w: any, schema: string, table: string, colNames: string[], pk: string, rows: any[]): Promise<void> {
    if (!rows.length) return;
    if (kind === 'PG') {
      const cols = colNames.map(pgq).join(', ');
      const upd = colNames.filter((c) => c !== pk).map((c) => `${pgq(c)}=EXCLUDED.${pgq(c)}`).join(', ');
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500); const p: any[] = [];
        const tuples = slice.map((row) => `(${colNames.map((c) => { p.push(jsonSafe(row[c])); return `$${p.length}`; }).join(', ')})`);
        await w.rawQuery(`INSERT INTO ${pgq(schema)}.${pgq(table)} (${cols}) VALUES ${tuples.join(', ')} ON CONFLICT (${pgq(pk)}) DO ${upd ? `UPDATE SET ${upd}` : 'NOTHING'}`, p);
      }
    } else if (kind === 'MYSQL') {
      const cols = colNames.map(myq).join(', ');
      const upd = colNames.filter((c) => c !== pk).map((c) => `${myq(c)}=VALUES(${myq(c)})`).join(', ');
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500); const p: any[] = [];
        const tuples = slice.map((row) => `(${colNames.map((c) => { p.push(jsonSafe(row[c])); return '?'; }).join(', ')})`);
        await w.rawQuery(`INSERT INTO ${myq(schema)}.${myq(table)} (${cols}) VALUES ${tuples.join(', ')}${upd ? ` ON DUPLICATE KEY UPDATE ${upd}` : ''}`, p);
      }
    } else if (kind === 'ORACLE') {
      const setCols = colNames.filter((c) => c !== pk);
      for (const row of rows) {                                   // MERGE per row (bind :1..:n)
        const p: any[] = colNames.map((c) => jsonSafe(row[c]));
        const srcSel = colNames.map((c, i) => `:${i + 1} AS ${orq(c)}`).join(', ');
        const onC = `t.${orq(pk)} = s.${orq(pk)}`;
        const upd = setCols.map((c) => `t.${orq(c)} = s.${orq(c)}`).join(', ');
        const insCols = colNames.map(orq).join(', ');
        const insVals = colNames.map((c) => `s.${orq(c)}`).join(', ');
        await w.rawQuery(`MERGE INTO ${orq(table)} t USING (SELECT ${srcSel} FROM dual) s ON (${onC})` +
          `${upd ? ` WHEN MATCHED THEN UPDATE SET ${upd}` : ''} WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals})`, p);
      }
    } else if (kind === 'MONGO') {
      await w.upsertDocs(schema, table, rows.map((r) => ({ _id: r[pk], ...r })));
    } else if (kind === 'ES') {
      await w.insertDocs(schema, table, rows.map((r) => ({ _id: String(r[pk]), ...r })));   // `table` = index
    }
  }

  /** Delete one row/doc by primary key (apply a CDC delete). */
  static async del(kind: DestKind, w: any, schema: string, table: string, pk: string, pkValue: any): Promise<void> {
    if (kind === 'PG') await w.rawQuery(`DELETE FROM ${pgq(schema)}.${pgq(table)} WHERE ${pgq(pk)}=$1`, [pkValue]);
    else if (kind === 'MYSQL') await w.rawQuery(`DELETE FROM ${myq(schema)}.${myq(table)} WHERE ${myq(pk)}=?`, [pkValue]);
    else if (kind === 'ORACLE') await w.rawQuery(`DELETE FROM ${orq(table)} WHERE ${orq(pk)}=:1`, [pkValue]);
    else if (kind === 'MONGO') await w.deleteById(schema, table, pkValue);
    else if (kind === 'ES') await w.deleteDoc(table, String(pkValue));   // `table` = index
  }
}
