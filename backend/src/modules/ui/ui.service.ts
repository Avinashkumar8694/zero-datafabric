import { pool } from '../../config/database';

export class UiService {
  /**
   * Fetches aggregated statistics for the Management Dashboard
   */
  static async getDashboardStats() {
    const client = await pool.connect();
    try {
      const { rows: tenants } = await client.query('SELECT count(*) FROM public.tenants');
      const { rows: sources } = await client.query('SELECT count(*) FROM public.data_sources');
      const { rows: metadata } = await client.query('SELECT count(*) FROM fabric_catalog.metadata');
      
      return {
        totalTenants: parseInt(tenants[0].count),
        activeSources: parseInt(sources[0].count),
        metadataEntries: parseInt(metadata[0].count),
        systemStatus: 'ONLINE'
      };
    } finally {
      client.release();
    }
  }
}
