import pool from '../config/db';

export const extractMetadata = async (dataSourceId: string, schemaName: string) => {
  // Extract column info from information_schema
  const query = `
    INSERT INTO metadata_catalog.data_dictionary (data_source_id, table_name, column_name, data_type, is_nullable)
    SELECT $1, table_name, column_name, data_type, is_nullable = 'YES'
    FROM information_schema.columns
    WHERE table_schema = $2
  `;
  
  await pool.query(query, [dataSourceId, schemaName]);
  console.log(`[Metadata] Extracted dictionary for ${schemaName}`);
};

export const runQualityChecks = async () => {
  console.log('[Quality] Starting periodic data quality assessment...');
  
  // Example: Check null rates for all tables in the dictionary
  const dictionary = await pool.query('SELECT DISTINCT table_name, column_name FROM metadata_catalog.data_dictionary');
  
  for (const row of dictionary.rows) {
    const nullRate = await pool.query('SELECT admin_functions.run_null_check($1, $2)', [row.table_name, row.column_name]);
    
    await pool.query(
      'INSERT INTO metadata_catalog.quality_metrics (entity_name, metric_name, metric_value) VALUES ($1, $2, $3)',
      [`${row.table_name}.${row.column_name}`, 'null_rate_percentage', nullRate.rows[0].run_null_check]
    );
  }
};
