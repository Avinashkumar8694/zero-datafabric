/**
 * Write-time value generation (capability compensation for writes).
 * ------------------------------------------------------------------
 * PostgreSQL fills columns from DEFAULTs at INSERT time — UUID_V7
 * (`uuid_generate_v7()`), a SEQUENCE (`nextval`), or a FUNCTIONAL default
 * (`generate_custom_id(region)`). MongoDB and other stores have no column
 * defaults, so those columns would be missing / inconsistent.
 *
 * This engine applies the SAME generators the fabric uses for Postgres columns to
 * a write on ANY engine, so IDs/values are consistent regardless of where the row
 * lands. It composes three sources of generated values:
 *   • UUID_V7   → the hub's `uuid_generate_v7()` (the same generator Postgres uses),
 *                 with a JS fallback if the primitive is absent.
 *   • sequence  → the FabricSequence engine (Postgres-style nextval for any engine).
 *   • function  → invoke a hub-hosted custom function as a value service
 *                 (e.g. generate_custom_id) — "function-as-a-service" compensation.
 *
 * A generator rule (per field): ( strategy:'UUID_V7' ) | ( sequence:'name', start?, increment? )
 *                             | ( function:'fn', args?:[...], schema?:'LogicalSchema' )
 */
import { pool } from '../../config/database';
import { randomUUID } from 'crypto';
import { FabricSequenceService } from './sequence.service';

/** Strip anything that isn't a safe identifier character. */
const ident = (s: string) => String(s).replace(/[^a-zA-Z0-9_]/g, '');

/**
 * Write-time value generation engine (see file-level overview). All methods
 * are static; the class is never instantiated.
 */
export class FabricWriteGenerators {
  /**
   * Resolve one generator rule to a concrete value.
   * Tries, in order: `(strategy: 'UUID_V7')`/`(uuid: true)` (hub
   * `uuid_generate_v7()`, with a JS `randomUUID()` fallback if the Postgres
   * primitive isn't installed), `(sequence)` (delegates to
   * (@link FabricSequenceService.nextval)), or `(function)` (invokes a
   * hub-hosted function as a value service, optionally under a tenant schema's
   * `search_path`).
   * @param tenantId tenant scope (for the sequence engine and schema resolution).
   * @param rule the generator rule (`(strategy | uuid | sequence | function, ...)`).
   * @param fallbackSchema logical schema to run a `function` rule under, if the rule doesn't specify its own.
   * @returns the generated value.
   * @throws if `rule` is not an object, or specifies none of `strategy`/`sequence`/`function`.
   */
  static async resolve(tenantId: string, rule: any, fallbackSchema?: string): Promise<any> {
    if (!rule || typeof rule !== 'object') throw new Error('generator rule must be an object');

    if (rule.strategy === 'UUID_V7' || rule.uuid === true) {
      try { const { rows } = await pool.query('SELECT public.uuid_generate_v7()::text AS v'); return rows[0].v; }
      catch { return randomUUID(); } // graceful fallback if the primitive isn't installed
    }

    if (rule.sequence) {
      const r = await FabricSequenceService.nextval(tenantId, String(rule.sequence), { start: rule.start, increment: rule.increment });
      return r.value;
    }

    if (rule.function) {
      const fn = ident(rule.function);
      const args: any[] = Array.isArray(rule.args) ? rule.args : [];
      const ph = args.map((_, i) => `$${i + 1}`).join(', ');
      const logical = rule.schema || fallbackSchema;
      const schemaName = logical ? `tenant_${ident(tenantId)}_${ident(logical)}` : null;
      const client = await pool.connect();
      try {
        // Run the hub-hosted function in the tenant schema (search_path) as a value service.
        if (schemaName) await client.query(`SET search_path TO "${schemaName}", public`);
        const { rows } = await client.query(`SELECT ${fn}(${ph}) AS v`, args);
        return rows[0].v;
      } finally {
        client.release();
      }
    }

    throw new Error('generator rule must specify one of: strategy | sequence | function');
  }

  /**
   * Apply a ( field: rule ) map to a document, returning a new doc with generated fields set.
   * @param tenantId tenant scope.
   * @param doc the source document (not mutated).
   * @param generate a `(field: rule)` map of fields to generate (see (@link resolve)).
   * @param fallbackSchema logical schema fallback for `function` rules that don't specify their own.
   * @returns a shallow copy of `doc` with every field in `generate` set to its resolved value.
   */
  static async apply(tenantId: string, doc: Record<string, any>, generate: Record<string, any>, fallbackSchema?: string): Promise<Record<string, any>> {
    const out = { ...doc };
    for (const field of Object.keys(generate || {})) {
      out[field] = await this.resolve(tenantId, generate[field], generate[field]?.schema || fallbackSchema);
    }
    return out;
  }
}
