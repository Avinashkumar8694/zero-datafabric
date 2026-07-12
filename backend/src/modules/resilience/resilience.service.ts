import { pool } from '../../config/database';

/**
 * ResilienceService — database high-availability/health diagnostics: reports
 * whether the connected Postgres instance is currently a replica or leader,
 * a rough replication-lag indicator, and raw replication statistics for
 * monitoring dashboards.
 */
export class ResilienceService {
  /**
   * Deep health check: verifies DB connectivity and reports whether this
   * instance is currently a leader or a replica (`pg_is_in_recovery()`), a
   * coarse replication-lag signal (compares receive vs. replay WAL LSNs — a
   * replica's real lag "duration" is not computed, only whether the two LSNs
   * currently match), and the count of connected replicas (leader only).
   * @returns On success: `{ status: 'HEALTHY', role, replicationLag, activeReplicas }`.
   *   On failure: `{ status: 'UNHEALTHY', error }` — errors are caught and
   *   returned rather than thrown, so this is always safe to call from a
   *   health-check endpoint.
   */
  static async checkDatabaseHealth() {
    try {
      const { rows } = await pool.query(`
        SELECT 
          pg_is_in_recovery() as is_replica,
          pg_last_wal_receive_lsn() as receive_lsn,
          pg_last_wal_replay_lsn() as replay_lsn,
          CASE 
            WHEN pg_is_in_recovery() THEN 0
            ELSE (SELECT count(*) FROM pg_stat_replication)
          END as connected_replicas
      `);
      
      const health = rows[0];
      return {
        status: 'HEALTHY',
        role: health.is_replica ? 'REPLICA' : 'LEADER',
        replicationLag: health.receive_lsn === health.replay_lsn ? '0ms' : 'calculating...',
        activeReplicas: parseInt(health.connected_replicas)
      };
    } catch (err: any) {
      return { status: 'UNHEALTHY', error: err.message };
    }
  }

  /**
   * Fetch raw replication statistics for every connected standby, backing the
   * replication-monitoring API/dashboard.
   * @returns All rows from Postgres's `pg_stat_replication` view (empty on a replica or if no standbys are connected).
   */
  static async getReplicationStats() {
    const { rows } = await pool.query('SELECT * FROM pg_stat_replication');
    return rows;
  }
}
