import { pool } from '../../config/database';

/**
 * EventService — real-time change notification and outbound event dispatch.
 *
 * Attaches Postgres `LISTEN`/`NOTIFY`-driven triggers so row changes are
 * published on the `fabric_events` channel, and provides helpers for
 * dispatching outbound webhooks and recording emitted events to the audit log.
 */
export class EventService {
  /**
   * Attach (or replace) a row-change notification trigger on a table so
   * INSERT/UPDATE/DELETE events are published via the shared
   * `notify_data_change()` trigger function (which builds a JSON payload of
   * the NEW/OLD record and NOTIFYs the `fabric_events` channel).
   * @param schemaName - Schema containing the target table.
   * @param tableName - Table to attach the trigger to (also used to derive the trigger name `trg_notify_<tableName>`).
   * @returns `(status: 'TRIGGER_ATTACHED', table)`.
   */
  static async attachEventTrigger(schemaName: string, tableName: string) {
    const client = await pool.connect();
    try {
      const triggerName = `trg_notify_${tableName}`;
      
      // 1. Create the trigger function if it doesn't exist
      // (This builds a JSON payload of the NEW/OLD record)
      await client.query(`
        CREATE OR REPLACE TRIGGER ${triggerName}
        AFTER INSERT OR UPDATE OR DELETE ON ${schemaName}.${tableName}
        FOR EACH ROW EXECUTE FUNCTION notify_data_change();
      `);
      
      return { status: 'TRIGGER_ATTACHED', table: tableName };
    } finally {
      client.release();
    }
  }

  /**
   * Dispatch an outbound webhook for an event, signed with an HMAC secret so
   * the receiver can verify authenticity. Currently a stub: logs the intent
   * to dispatch but does not sign or POST the payload — in production this
   * would be wrapped in a durable (e.g. BullMQ) job for retry/at-least-once delivery.
   * @param url - The destination webhook URL.
   * @param payload - The event payload to deliver.
   * @param secret - The HMAC signing secret shared with the receiver.
   * @returns Resolves once the dispatch has been logged/initiated.
   */
  static async dispatchWebhook(url: string, payload: any, secret: string) {
    // Logic to sign payload with HMAC and POST to the URL
    // (This would be wrapped in a BullMQ job in production)
    console.log(`[Events] Dispatching event to ${url}...`);
  }

  /**
   * Internal event emitter: records an event as an audit-log row. In
   * production this would instead (or additionally) publish to `fabric_events`
   * or a message broker for real-time subscribers.
   * @param eventType - The event's type/action label (stored as `action`).
   * @param payload - Event payload; `payload.table`/`payload.tenantId` are
   *   used for the log's `table_name`/`tenant_id` (default to `'SYSTEM'`), and
   *   the full payload is stored as `new_data`.
   * @returns Resolves once the audit log row is written.
   */
  static async emit(eventType: string, payload: any) {
    console.log(`[Events] Emitting ${eventType}:`, JSON.stringify(payload));
    // In production, this would write to fabric_events or a message broker
    await pool.query(
      'INSERT INTO public.audit_logs (action, table_name, tenant_id, new_data) VALUES ($1, $2, $3, $4)', 
      [eventType, payload.table || 'SYSTEM', payload.tenantId || 'SYSTEM', JSON.stringify(payload)]
    );
  }
}
