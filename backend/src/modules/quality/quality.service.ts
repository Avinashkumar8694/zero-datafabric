import { pool } from '../../config/database';

/**
 * QualityService — computes and persists basic data-quality metrics
 * (null rate, cardinality/uniqueness) for a cataloged column by pushing the
 * aggregation down as a single SQL query against the column's actual table,
 * rather than pulling rows into the application.
 */
export class QualityService {
  /**
   * Compute and store data-quality metrics for a single cataloged column:
   * looks up the column's schema/table/name from `fabric_catalog.metadata`,
   * runs a pushdown aggregate (`count(*)`, null count, distinct count)
   * against the live table, then writes NULL_RATE and UNIQUENESS rows to
   * `fabric_catalog.quality_metrics`.
   * @param metadataId - The `fabric_catalog.metadata` row id identifying the target column.
   * @returns `{ metadataId, nullRate, uniqueness }` — `nullRate` is a percentage (0-100).
   * @throws {Error} 'Metadata entry not found' if `metadataId` does not exist.
   */
  static async runQualityCheck(metadataId: string) {
    const client = await pool.connect();
    try {
      // 1. Fetch metadata for the target column
      const { rows: meta } = await client.query(
        'SELECT schema_name, table_name, column_name FROM fabric_catalog.metadata WHERE id = $1',
        [metadataId]
      );

      if (meta.length === 0) throw new Error('Metadata entry not found');
      const { schema_name, table_name, column_name } = meta[0];

      // 2. Execute pushdown query to compute metrics
      // This query is optimized to run on the Hub (or pushed to FDW source)
      const { rows: metrics } = await client.query(`
        SELECT 
          count(*) as total_count,
          count(*) FILTER (WHERE ${column_name} IS NULL) as null_count,
          count(DISTINCT ${column_name}) as unique_values
        FROM ${schema_name}.${table_name}
      `);

      const stats = metrics[0];
      const nullRate = (parseInt(stats.null_count) / parseInt(stats.total_count)) * 100;

      // 3. Save to metrics store
      await client.query(`
        INSERT INTO fabric_catalog.quality_metrics (column_id, metric_type, metric_value)
        VALUES ($1, 'NULL_RATE', $2), ($1, 'UNIQUENESS', $3)
      `, [metadataId, nullRate, stats.unique_values]);

      return { metadataId, nullRate, uniqueness: stats.unique_values };
    } finally {
      client.release();
    }
  }
}
