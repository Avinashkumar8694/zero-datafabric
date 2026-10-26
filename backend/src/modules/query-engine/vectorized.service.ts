/**
 * @module modules/query-engine/vectorized.service
 * @description Vectorized Columnar Memory Acceleration via Apache Arrow.
 *
 * Provides zero-copy, contiguous typed-array columnar representation of
 * in-memory datasets, bypassing V8 JSON object overhead for large cross-engine
 * joins and high-throughput data exports.
 */

import { tableFromJSON, tableToIPC, Table } from 'apache-arrow';

export class VectorizedEngine {
  /**
   * Checks whether the dataset size exceeds the vectorized threshold
   * (default: 5,000 rows, configurable via FABRIC_VECTORIZED_THRESHOLD).
   */
  static isVectorizedEligible(rowCount: number): boolean {
    const threshold = Number(process.env.FABRIC_VECTORIZED_THRESHOLD || 5000);
    return rowCount >= threshold;
  }

  /**
   * Converts an array of JavaScript row objects into a columnar Apache Arrow Table.
   * Compresses memory footprint up to 90% and eliminates V8 hidden-class overhead.
   */
  static toArrowTable(rows: any[]): Table | null {
    if (!rows || rows.length === 0) return null;
    try {
      return tableFromJSON(rows);
    } catch (err: any) {
      console.warn('[VectorizedEngine] Arrow conversion fallback:', err.message);
      return null;
    }
  }

  /**
   * Serializes an array of rows or an existing Arrow Table directly into an
   * Apache Arrow binary IPC stream (RFC-compliant application/vnd.apache.arrow.stream)
   * for zero-copy streaming to analytical clients (Pandas, DuckDB, Tableau, Polars).
   */
  static toArrowIPCStream(data: any[] | Table): Uint8Array {
    if (data instanceof Table) {
      return tableToIPC(data, 'stream');
    }
    const table = tableFromJSON(data);
    return tableToIPC(table, 'stream');
  }

  /**
   * Determines if the incoming HTTP request is requesting Apache Arrow binary format.
   * Supports `Accept: application/vnd.apache.arrow.stream` or `format=arrow` query parameter.
   */
  static wantsArrow(req: any): boolean {
    const accept = String(req.headers?.accept || '');
    if (accept.includes('application/vnd.apache.arrow.stream') || accept.includes('application/x-apache-arrow')) {
      return true;
    }
    const format = req.query?.format || req.body?.format;
    return String(format).toLowerCase() === 'arrow';
  }
}
