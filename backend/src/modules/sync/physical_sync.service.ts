/**
 * PhysicalSync — real SYNC / CDC replication of a remote source into the hub.
 *
 * Unlike VIRTUAL (query the source live via its connector), SYNC/CDC copy the
 * source's rows into the tenant's hub Postgres schema (`tenant_<id>_<schema>`),
 * so the planner classifies the source as `reachableInPg` and serves it as one
 * native hub SQL statement (fast local joins, no per-query round-trip to the
 * source).
 *
 *   • SYNC — one-shot (or on-demand) FULL backfill: create matching hub tables
 *     and bulk-copy every row. Re-running truncates + reloads.
 *   • CDC  — backfill + INCREMENTAL refresh: each poll pulls only rows whose
 *     watermark column (e.g. `updated_at` / `id`) advanced past the last seen
 *     value and upserts them, so the hub replica tracks the source over time.
 *     Configured per source as `config.cdc = { column, intervalMs }`.
 *
 * DDL/DML run as `fabric_admin` (the pool) since creating schemas/tables needs
 * privileges the low-priv tenant role lacks.
 */
import { pool } from '../../config/database';
import { ConnectorFactory } from '../metadata/connectors/factory';
import { canonicalType } from '../metadata/ddl_render';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys', 'admin', 'config', 'local', 'pg_catalog']);
const COPY_CAP = Number(process.env.FABRIC_SYNC_MAX_ROWS) || 200000;

/** Sanitize a tenant id into the hub schema prefix, matching `toTenantSchemaName`. */
function hubSchemaFor(tenantId: string, schema: string): string {
  return `tenant_${String(tenantId).replace(/[^a-zA-Z0-9_]/g, '')}_${String(schema).replace(/[^a-zA-Z0-9_]/g, '')}`;
}
const q = (id: string) => '"' + String(id).replace(/"/g, '') + '"';

export interface SyncResult {
  source: string; engine: string; mode: 'SYNC' | 'CDC';
  tables: { schema: string; table: string; rows: number; mode: string }[];
  errors: string[];
}

export class PhysicalSync {
  /**
   * FULL backfill of a source into the hub. Creates `tenant_<id>_<schema>` hub
   * schemas + matching tables and bulk-copies every TABLE resource's rows.
   * Idempotent: existing hub tables are truncated and reloaded. For CDC sources
   * it also records the initial watermark so subsequent refreshes are incremental.
   *
   * @param tenantId tenant id.
   * @param sourceName the logical source name (must be a registered data source).
   * @returns a per-table row-count summary.
   */
  static async backfill(tenantId: string, sourceName: string): Promise<SyncResult> {
    const src = await this.getSource(tenantId, sourceName);
    const mode = (src.sync_type || 'SYNC').toUpperCase() === 'CDC' ? 'CDC' : 'SYNC';
    const cdcCol: string | undefined = src.config?.cdc?.column;
    const connector: any = ConnectorFactory.getConnector(src.type, src.config);
    const result: SyncResult = { source: sourceName, engine: String(src.type).toUpperCase(), mode, tables: [], errors: [] };
    try {
      const schemas = (await connector.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      for (const s of schemas) {
        const schemaName = s.name;
        const hubSchema = hubSchemaFor(tenantId, schemaName);
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${q(hubSchema)}`);
        // Queries run as the low-priv `fabric_user` role — grant it access to the replica.
        await this.grantTenantAccess(hubSchema);
        const tables = (await connector.discoverTables(schemaName)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE');
        for (const t of tables) {
          try {
            const rows = await this.copyTable(connector, schemaName, t.name, hubSchema);
            result.tables.push({ schema: schemaName, table: t.name, rows, mode: 'full' });
            if (mode === 'CDC' && cdcCol) await this.recordWatermark(tenantId, sourceName, hubSchema, t.name, cdcCol);
          } catch (e: any) { result.errors.push(`${schemaName}.${t.name}: ${e.message}`); }
        }
        await this.grantTenantAccess(hubSchema); // re-grant to cover the tables just created
      }
    } finally { await connector.close().catch(() => {}); }
    return result;
  }

  /** Grant the low-priv tenant role read/write on a replica schema (queries run as `fabric_user`). */
  private static async grantTenantAccess(hubSchema: string): Promise<void> {
    try {
      await pool.query(`GRANT USAGE ON SCHEMA ${q(hubSchema)} TO fabric_user`);
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q(hubSchema)} TO fabric_user`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${q(hubSchema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user`);
    } catch { /* fabric_user role may not exist in some envs; grants are best-effort */ }
  }

  /** Create the hub table from discovered columns, truncate, and bulk-load all source rows. */
  private static async copyTable(connector: any, schema: string, table: string, hubSchema: string): Promise<number> {
    const cols: any[] = connector.discoverColumns ? await connector.discoverColumns(schema, table) : [];
    if (!cols.length) throw new Error('no columns discovered');
    const colDefs = cols.map((c) => `${q(c.name)} ${canonicalType(c.type)}`);
    // Carry the source PK into the replica so CDC upserts (ON CONFLICT) have a key.
    const pkCols = cols.filter((c) => c.primaryKey).map((c) => q(c.name));
    if (pkCols.length) colDefs.push(`PRIMARY KEY (${pkCols.join(', ')})`);
    // DROP+CREATE (not CREATE IF NOT EXISTS) so schema/PK changes apply on re-sync; a full
    // backfill reloads every row anyway.
    await pool.query(`DROP TABLE IF EXISTS ${q(hubSchema)}.${q(table)}`);
    await pool.query(`CREATE TABLE ${q(hubSchema)}.${q(table)} (${colDefs.join(', ')})`);
    const rows: any[] = await connector.query(schema, table, { limit: COPY_CAP });
    await this.bulkInsert(hubSchema, table, cols.map((c) => c.name), rows);
    return rows.length;
  }

  /** Parameterized multi-row INSERT in batches (jsonb/object values are JSON-encoded). */
  private static async bulkInsert(hubSchema: string, table: string, colNames: string[], rows: any[]): Promise<void> {
    if (!rows.length) return;
    const colList = colNames.map(q).join(', ');
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const params: any[] = [];
      const tuples = slice.map((row) => {
        const ph = colNames.map((c) => {
          let v = row[c];
          if (v !== null && typeof v === 'object') v = JSON.stringify(v);
          params.push(v === undefined ? null : v);
          return `$${params.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      await pool.query(`INSERT INTO ${q(hubSchema)}.${q(table)} (${colList}) VALUES ${tuples.join(', ')}`, params);
    }
  }

  /**
   * INCREMENTAL CDC refresh: for each synced table with a watermark column, pull
   * source rows where `column > lastWatermark`, upsert into the hub replica, and
   * advance the watermark. Requires the source to be CDC with `config.cdc.column`.
   * @param tenantId tenant id.
   * @param sourceName the logical source name.
   * @returns per-table counts of rows refreshed.
   */
  static async refreshCdc(tenantId: string, sourceName: string): Promise<SyncResult> {
    const src = await this.getSource(tenantId, sourceName);
    const cdcCol: string | undefined = src.config?.cdc?.column;
    const result: SyncResult = { source: sourceName, engine: String(src.type).toUpperCase(), mode: 'CDC', tables: [], errors: [] };
    if (!cdcCol) { result.errors.push('no cdc.column configured'); return result; }
    const connector: any = ConnectorFactory.getConnector(src.type, src.config);
    try {
      const schemas = (await connector.discoverSchemas()).filter((s: any) => !SYSTEM_SCHEMAS.has(String(s.name).toLowerCase()));
      for (const s of schemas) {
        const hubSchema = hubSchemaFor(tenantId, s.name);
        const tables = (await connector.discoverTables(s.name)).filter((t: any) => (t.resourceType || 'TABLE') === 'TABLE');
        for (const t of tables) {
          try {
            const cols: any[] = await connector.discoverColumns(s.name, t.name);
            if (!cols.some((c) => c.name === cdcCol)) continue; // table has no watermark column → skip
            const wm = await this.getWatermark(tenantId, sourceName, hubSchema, t.name);
            const filter = wm != null ? { [cdcCol]: { $gt: wm } } : {};
            const rows: any[] = await connector.query(s.name, t.name, { filter, orderBy: [{ field: cdcCol, dir: 'ASC' }], limit: COPY_CAP });
            if (rows.length) {
              const pk = cols.find((c) => c.primaryKey)?.name || cdcCol;
              await this.upsert(hubSchema, t.name, cols.map((c) => c.name), pk, rows);
              const maxWm = rows.reduce((m, r) => (r[cdcCol] > m ? r[cdcCol] : m), rows[0][cdcCol]);
              await this.setWatermark(tenantId, sourceName, hubSchema, t.name, cdcCol, maxWm);
            }
            result.tables.push({ schema: s.name, table: t.name, rows: rows.length, mode: 'incremental' });
          } catch (e: any) { result.errors.push(`${s.name}.${t.name}: ${e.message}`); }
        }
      }
    } finally { await connector.close().catch(() => {}); }
    return result;
  }

  /** Upsert rows into the hub replica keyed by `pk` (ON CONFLICT DO UPDATE). */
  private static async upsert(hubSchema: string, table: string, colNames: string[], pk: string, rows: any[]): Promise<void> {
    const colList = colNames.map(q).join(', ');
    const updates = colNames.filter((c) => c !== pk).map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
    for (const row of rows) {
      const params: any[] = [];
      const ph = colNames.map((c) => { let v = row[c]; if (v !== null && typeof v === 'object') v = JSON.stringify(v); params.push(v === undefined ? null : v); return `$${params.length}`; });
      const conflict = updates ? `ON CONFLICT (${q(pk)}) DO UPDATE SET ${updates}` : `ON CONFLICT (${q(pk)}) DO NOTHING`;
      await pool.query(`INSERT INTO ${q(hubSchema)}.${q(table)} (${colList}) VALUES (${ph.join(', ')}) ${conflict}`, params);
    }
  }

  // ---- watermark state (fabric_system.cdc_state) ----
  private static async ensureState(): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.cdc_state (
      tenant_id text, source_name text, hub_schema text, table_name text,
      watermark_column text, watermark_value text, updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, source_name, hub_schema, table_name))`);
  }
  private static async recordWatermark(tenantId: string, source: string, hubSchema: string, table: string, col: string): Promise<void> {
    await this.ensureState();
    // Seed the watermark to the current MAX so the first refresh only picks up NEW rows.
    const r = await pool.query(`SELECT MAX(${q(col)})::text AS mx FROM ${q(hubSchema)}.${q(table)}`).catch(() => ({ rows: [{ mx: null }] }));
    await this.setWatermark(tenantId, source, hubSchema, table, col, r.rows[0]?.mx ?? null);
  }
  private static async getWatermark(tenantId: string, source: string, hubSchema: string, table: string): Promise<any> {
    await this.ensureState();
    const r = await pool.query(`SELECT watermark_value FROM fabric_system.cdc_state WHERE tenant_id=$1 AND source_name=$2 AND hub_schema=$3 AND table_name=$4`, [tenantId, source, hubSchema, table]);
    return r.rows[0]?.watermark_value ?? null;
  }
  private static async setWatermark(tenantId: string, source: string, hubSchema: string, table: string, col: string, value: any): Promise<void> {
    await this.ensureState();
    await pool.query(`INSERT INTO fabric_system.cdc_state (tenant_id, source_name, hub_schema, table_name, watermark_column, watermark_value, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6, now())
      ON CONFLICT (tenant_id, source_name, hub_schema, table_name)
      DO UPDATE SET watermark_column=EXCLUDED.watermark_column, watermark_value=EXCLUDED.watermark_value, updated_at=now()`,
      [tenantId, source, hubSchema, table, col, value == null ? null : String(value)]);
  }

  private static async getSource(tenantId: string, sourceName: string): Promise<any> {
    const r = await pool.query(`SELECT name, type, sync_type, config FROM public.data_sources WHERE tenant_id=$1 AND name=$2`, [tenantId, sourceName]);
    if (!r.rows.length) throw new Error(`source "${sourceName}" not found for tenant "${tenantId}"`);
    return r.rows[0];
  }

  /**
   * Background poller: every `intervalMs` (min across CDC sources, default 15s)
   * refresh each CDC source. Idempotent start.
   */
  private static started = false;
  static startCdcPoller(intervalMs = Number(process.env.FABRIC_CDC_POLL_MS) || 15000): void {
    if (this.started) return;
    this.started = true;
    setInterval(async () => {
      try {
        const { rows } = await pool.query(`SELECT tenant_id, name FROM public.data_sources WHERE UPPER(sync_type)='CDC' AND status='CONNECTED'`);
        for (const s of rows) await this.refreshCdc(s.tenant_id, s.name).catch(() => {});
      } catch { /* poller is best-effort */ }
    }, intervalMs).unref?.();
    console.log(`[PhysicalSync] CDC poller started (${intervalMs}ms)`);
  }
}
