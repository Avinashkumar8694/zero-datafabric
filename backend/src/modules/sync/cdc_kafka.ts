/**
 * cdc_kafka — Kafka-backed CDC delivery (production-grade, memory-safe, durable).
 *
 * Design (see developer_docs/replication.md → "Kafka-backed CDC"):
 *   Source ──(trigger+outbox / change-stream)──▶ PRODUCER ──▶ Kafka topic ──▶ CONSUMER ──▶ ES/hub
 *            durable capture (on disk)            drains in     durable log      applies + commits
 *                                                 bounded         (on disk)       offset AFTER apply
 *                                                 batches
 *
 * Durability + no-loss-on-restart:
 *   • The source outbox is the crash-safe capture buffer (written in the source txn).
 *   • The PRODUCER drains the outbox in bounded batches and advances its offset ONLY after
 *     Kafka acks (`acks=all`), then prunes the outbox — so a producer/Kafka crash loses
 *     nothing (unpublished changes stay in the outbox on disk).
 *   • The CONSUMER disables auto-commit and commits the Kafka offset ONLY after the sink
 *     apply succeeds — so a consumer crash re-delivers, and apply is idempotent
 *     (upsert/delete by `_id`) → effectively exactly-once effect.
 *
 * Memory: every hop is a bounded batch, so heap is O(batch), never O(backlog). Backlogs
 * live on disk (source outbox + Kafka log), not in the process.
 */
import { Kafka, logLevel, Producer } from 'kafkajs';
import { pool } from '../../config/database';
import { CdcCapture } from './cdc_capture';

const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const BATCH = Number(process.env.FABRIC_CDC_KAFKA_BATCH) || 500;
const kafka = new Kafka({ clientId: 'fabric-cdc', brokers: BROKERS, logLevel: logLevel.NOTHING });
const safe = (s: string) => String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');

/** Kafka topic for a source's change stream (one per tenant+source; keyed by table:pk for order). */
export const cdcTopic = (tenantId: string, source: string) => `cdc.${safe(tenantId)}.${safe(source)}`;

export class CdcKafka {
  private static producer: Producer | null = null;

  private static async ensureOffsetTable(): Promise<void> {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
    await pool.query(`CREATE TABLE IF NOT EXISTS fabric_system.cdc_kafka_offset (k text PRIMARY KEY, seq bigint NOT NULL DEFAULT 0)`);
  }
  private static async getProdSeq(k: string): Promise<number> {
    await this.ensureOffsetTable();
    const r = await pool.query(`SELECT seq FROM fabric_system.cdc_kafka_offset WHERE k=$1`, [k]);
    return Number(r.rows[0]?.seq || 0);
  }
  private static async setProdSeq(k: string, seq: number): Promise<void> {
    await pool.query(`INSERT INTO fabric_system.cdc_kafka_offset (k, seq) VALUES ($1,$2)
      ON CONFLICT (k) DO UPDATE SET seq=EXCLUDED.seq`, [k, seq]);
  }

  /** Baseline the producer offset (called after an initial snapshot so pre-snapshot outbox rows aren't republished). */
  static async baseline(tenantId: string, source: string, schema: string, table: string, seq: number): Promise<void> {
    await this.setProdSeq(`${tenantId}:${source}:${schema}.${table}`, seq);
  }

  private static async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    const p = kafka.producer({ allowAutoTopicCreation: true });
    await p.connect();
    this.producer = p;
    return p;
  }

  /**
   * PRODUCER: drain a source table's outbox into Kafka in bounded batches, advancing the
   * producer offset only after each batch is acked, then prune the published outbox rows.
   * Returns the number of change events published.
   */
  static async produce(engine: string, conn: any, tenantId: string, source: string, schema: string, table: string): Promise<number> {
    const topic = cdcTopic(tenantId, source);
    const offKey = `${tenantId}:${source}:${schema}.${table}`;
    const producer = await this.getProducer();
    let seq = await this.getProdSeq(offKey);
    let published = 0;
    for (;;) {
      const changes = await CdcCapture.read(engine, conn, schema, table, seq, BATCH);   // bounded read
      if (!changes.length) break;
      await producer.send({
        topic, acks: -1,                                                                // wait for all replicas
        messages: changes.map((c) => ({
          key: `${table}:${c.pk}`,                                                      // per-row ordering
          value: JSON.stringify({ tenant: tenantId, source, schema, table, op: c.op, pk: c.pk, doc: c.doc, seq: c.seq }),
        })),
      });
      seq = changes[changes.length - 1]!.seq;
      await this.setProdSeq(offKey, seq);                                               // advance ONLY after ack → no loss
      published += changes.length;
      if (changes.length < BATCH) break;
    }
    if (published) await CdcCapture.prune(engine, conn, schema, table, seq);            // safe: durably in Kafka now
    return published;
  }

  /**
   * CONSUMER: long-lived loop applying a source's change stream from Kafka to an ES sink.
   * Manual offset commit AFTER apply → at-least-once + idempotent (upsert/delete by _id).
   * @param resolveDest maps an event's (source) → { index-building destSchema } and the ES writer.
   */
  static async startEsConsumer(
    tenantId: string, source: string, groupId: string,
    apply: (ev: { table: string; op: 'I' | 'U' | 'D'; pk: string; doc: any }) => Promise<void>,
  ): Promise<() => Promise<void>> {
    const consumer = kafka.consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic: cdcTopic(tenantId, source), fromBeginning: true });
    await consumer.run({
      autoCommit: false,                                                               // commit manually after apply
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
        for (const msg of batch.messages) {
          if (!isRunning() || isStale()) break;
          if (!msg.value) { resolveOffset(msg.offset); continue; }
          const ev = JSON.parse(msg.value.toString());
          await apply({ table: ev.table, op: ev.op, pk: ev.pk, doc: ev.doc });         // idempotent sink apply
          resolveOffset(msg.offset);                                                   // mark applied
          await heartbeat();
        }
        await commitOffsetsIfNecessary();                                              // commit AFTER applying the batch
      },
    });
    console.log(`[CdcKafka] ES consumer running: topic ${cdcTopic(tenantId, source)} group ${groupId}`);
    return async () => { await consumer.disconnect().catch(() => {}); };
  }

  static async disconnect(): Promise<void> { if (this.producer) { await this.producer.disconnect().catch(() => {}); this.producer = null; } }
}
