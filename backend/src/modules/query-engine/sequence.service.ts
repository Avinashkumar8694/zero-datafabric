/**
 * Fabric Sequence engine (write-side capability compensation).
 * -------------------------------------------------------------
 * PostgreSQL has `CREATE SEQUENCE` / `nextval()`; MongoDB (and other stores) do
 * not. To keep ID-generation semantics CONSISTENT across engines, the fabric
 * provides its OWN sequence engine: a monotonic, atomic allocator in the
 * control-plane hub. A caller inserting into a Mongo collection can ask the fabric
 * for the next value(s) and get exactly the guarantees a Postgres sequence gives
 * (gap-free within a block, no duplicates under concurrency).
 *
 * Atomicity: allocation is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement — Postgres row-locks the sequence row, so concurrent callers never get
 * the same value. Block allocation (`count > 1`) reserves a contiguous range in one
 * round-trip, so bulk inserts don't pay per-row latency.
 */
import { pool } from '../../config/database';

/**
 * Engine-agnostic sequence allocator (see file-level overview for why this
 * exists and its atomicity guarantee). All methods are static; the class is never instantiated.
 */
export class FabricSequenceService {
  private static ensured = false;

  /** Lazily create the `fabric_system.fabric_sequences` table (idempotent, runs at most once per process). */
  private static async ensure(): Promise<void> {
    if (this.ensured) return;
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fabric_system.fabric_sequences (
        tenant_id     text   NOT NULL,
        name          text   NOT NULL,
        current_value bigint NOT NULL DEFAULT 0,
        increment     integer NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id, name)
      )`);
    this.ensured = true;
  }

  /**
   * Allocate the next value (or a contiguous block) of a named sequence.
   * @param tenantId tenant scope
   * @param name sequence name
   * @param opts.start first value on creation (default 1)
   * @param opts.increment step (default 1)
   * @param opts.count how many contiguous values to reserve (default 1)
   * @returns {Promise<Object>} `(name, value)` for count=1, or `(name, values)` for a block
   */
  static async nextval(
    tenantId: string, name: string,
    opts: { start?: number; increment?: number; count?: number } = {}
  ): Promise<{ name: string; value?: number; values?: number[] }> {
    await this.ensure();
    if (!name || !/^[A-Za-z0-9_]+$/.test(name)) throw new Error('sequence name must be a plain identifier');
    const inc = Number.isFinite(opts.increment as number) ? Math.trunc(opts.increment as number) : 1;
    const start = Number.isFinite(opts.start as number) ? Math.trunc(opts.start as number) : 1;
    const count = Math.max(1, Math.min(100000, Math.trunc(opts.count || 1)));

    // First allocation seeds current_value to the LAST value of the initial block
    // (start .. start+inc*(count-1)); subsequent allocations advance by inc*count.
    const { rows } = await pool.query(
      `INSERT INTO fabric_system.fabric_sequences (tenant_id, name, current_value, increment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, name)
       DO UPDATE SET current_value = fabric_system.fabric_sequences.current_value
                     + (fabric_system.fabric_sequences.increment * $5)
       RETURNING current_value, increment`,
      [tenantId, name, start + inc * (count - 1), inc, count]
    );
    const end = Number(rows[0].current_value);
    const step = Number(rows[0].increment);
    if (count === 1) return { name, value: end };
    const values: number[] = [];
    for (let i = count - 1; i >= 0; i--) values.push(end - step * i);
    return { name, values };
  }

  /**
   * Current value without advancing (null if never allocated).
   * @param tenantId tenant scope.
   * @param name sequence name.
   * @returns the sequence's current value, or `null` if `nextval` was never called for it.
   */
  static async currval(tenantId: string, name: string): Promise<number | null> {
    await this.ensure();
    const { rows } = await pool.query(
      `SELECT current_value FROM fabric_system.fabric_sequences WHERE tenant_id=$1 AND name=$2`, [tenantId, name]);
    return rows.length ? Number(rows[0].current_value) : null;
  }
}
