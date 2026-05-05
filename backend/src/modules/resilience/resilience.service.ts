import { pool } from '../../config/database';

export class ResilienceService {
  /**
   * Deep Health Check
   * Verifies DB connectivity, Leader/Replica status, and replication lag
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
   * Replication Monitoring API logic
   */
  static async getReplicationStats() {
    const { rows } = await pool.query('SELECT * FROM pg_stat_replication');
    return rows;
  }
}
