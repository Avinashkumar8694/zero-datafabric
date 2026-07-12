import { pool } from '../../config/database';

/**
 * UiService — read-only aggregation helpers backing the management-console UI.
 */
export class UiService {
  /**
   * Fetch top-line counts for the management dashboard's summary tiles:
   * total tenants, active data sources, and cataloged metadata entries.
   * @returns `{ totalTenants, activeSources, metadataEntries, systemStatus: 'ONLINE' }`.
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
