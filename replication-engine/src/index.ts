/**
 * replication-engine — standalone microservice that executes the fabric's heavy
 * copy jobs (physical SYNC, CDC refresh, source→source REPLICATE, DR RESTORE).
 *
 * This is a **separate project** (its own package.json/process), mirroring
 * `trigger-engine/`. The data-fabric API only *assigns* work — it writes rows to
 * `fabric_system.copy_jobs`. This process is the worker that:
 *   • claims queued jobs (`FOR UPDATE SKIP LOCKED`, safe to run many replicas),
 *   • executes them honoring per-job config (page size, memory ceiling, row cap),
 *   • checkpoints each committed batch so a crash/restart resumes with no data loss,
 *   • honors pause/resume and reclaims jobs orphaned by a dead worker.
 *
 * It shares the fabric's connector + copy core by importing the backend modules
 * directly (single source of truth — no logic drift), so it needs the backend's
 * dependencies resolvable (run from the repo with the backend installed).
 *
 * Run:  npm --prefix replication-engine start
 * Set  REPLICATION_ENGINE_EXTERNAL=true  on the API so it does NOT also run an
 * embedded worker (avoids double-processing). Scale by launching N copies with
 * distinct WORKER_ID; SKIP LOCKED gives each job to exactly one worker.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load the backend's .env so DATABASE_URL (and friends) resolve identically to the API.
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

// Import the shared copy engine + control-plane pool from the backend (single source of truth).
import { CopyJobEngine } from '../../backend/src/modules/jobs/copy_job_engine';
import { ReplicationService } from '../../backend/src/modules/replication/replication.service';
import { pool } from '../../backend/src/config/database';

const POLL_MS = Number(process.env.FABRIC_COPY_POLL_MS) || 2000;
const WORKER_ID = process.env.WORKER_ID || `replication-engine-${process.pid}`;

async function main() {
  await pool.query('SELECT 1');            // fail fast if the control-plane DB is unreachable
  await CopyJobEngine.ensureTable();
  console.log(`\x1b[32m✔ Replication engine online — worker "${WORKER_ID}", poll ${POLL_MS}ms\x1b[0m`);
  CopyJobEngine.startWorker(POLL_MS, WORKER_ID);
  // Long-lived Kafka CDC→ES consumers (no-op unless FABRIC_CDC_VIA_KAFKA=true).
  await ReplicationService.startCdcConsumers();
}

main().catch((e) => {
  console.error(`\x1b[31m[FATAL] Replication engine failed to start: ${e.message}\x1b[0m`);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\n[replication-engine] shutting down'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
