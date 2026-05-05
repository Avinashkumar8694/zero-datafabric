import { pool } from '../../config/database';

export class MetadataService {
  /**
   * Advanced Discovery Crawler
   * Orchestrates the extraction of metadata from virtualized schemas
   */
  static async crawlTenant(tenantId: string) {
    const schemaName = `tenant_${tenantId}`;
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // 1. Fetch raw metadata from Postgres Catalog (Native + Virtual FDW)
      const { rows: columns } = await client.query(`
        SELECT 
          table_name, column_name, data_type, is_nullable,
          column_default as default_value
        FROM information_schema.columns
        WHERE table_schema = $1
      `, [schemaName]);

      // 2. UPSERT into the Data Fabric Catalog
      for (const col of columns) {
        await client.query(`
          INSERT INTO fabric_catalog.metadata 
            (schema_name, table_name, column_name, data_type, is_nullable)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (schema_name, table_name, column_name) 
          DO UPDATE SET 
            data_type = EXCLUDED.data_type,
            last_crawled_at = CURRENT_TIMESTAMP
        `, [schemaName, col.table_name, col.column_name, col.data_type, col.is_nullable === 'YES']);
      }

      await client.query('COMMIT');
      return { tenantId, columnCount: columns.length };
    } catch (err: any) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Full-Text Search across the Fabric Catalog
   */
  static async searchCatalog(tenantId: string, query: string) {
    const { rows } = await pool.query(`
      SELECT table_name, column_name, data_type, description
      FROM fabric_catalog.metadata
      WHERE schema_name = $1
      AND (
        table_name ILIKE $2 OR 
        column_name ILIKE $2 OR 
        description ILIKE $2
      )
    `, [`tenant_${tenantId}`, `%${query}%`]);
    
    return rows;
  }
}
