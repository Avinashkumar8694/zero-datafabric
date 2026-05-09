import { pool } from '../../config/database';
import { DiffEngine } from './diff_engine';
import { Transpiler } from './transpiler';
import { MetadataManifest } from './types';

export class MetadataOrchestrator {
    static async apply(tenantId: string, manifest: MetadataManifest, options: { force?: boolean } = {}) {
        this.validateManifest(manifest); // Stage 1: Validation

        const plan = await this.plan(tenantId, manifest);
        
        if (plan.summary.highRisk > 0 && !options.force) {
            throw new Error(`CRITICAL: ${plan.summary.highRisk} High-Risk changes detected. Use force=true to override.`);
        }

        const client = await pool.connect();
        const results: any[] = [];

        try {
            await client.query('BEGIN');
            
            await this.ensureBaseInfrastructure(client);

            for (const diff of plan.changes) {
                const sqls = await Transpiler.toSql(diff, tenantId, manifest);
                for (const sql of sqls) {
                    await client.query(sql);
                }
                results.push({ action: diff.action, name: diff.name || diff.table, status: 'SUCCESS' });
            }

            await this.persistMetadataState(client, tenantId, manifest, plan.summary);

            await client.query('COMMIT');
            return {
                status: 'APPLIED',
                manifestVersion: manifest.version,
                appliedCount: results.length,
                details: results
            };
        } catch (err: any) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    private static async ensureBaseInfrastructure(client: any) {
        await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await client.query(`CREATE SCHEMA IF NOT EXISTS fabric_system`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS fabric_system.metadata_history (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id TEXT,
                version_tag TEXT,
                ast_content JSONB,
                applied_at TIMESTAMP DEFAULT NOW(),
                summary JSONB
            )
        `);
        const colCheck = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'fabric_system' AND table_name = 'metadata_history' AND column_name = 'created_at'`);
        if (colCheck.rows.length > 0) {
            await client.query(`ALTER TABLE fabric_system.metadata_history RENAME COLUMN created_at TO applied_at`);
        }
    }

    static async plan(tenantId: string, manifest: MetadataManifest) {
        const diffs = await DiffEngine.compare(tenantId, manifest);
        return {
            status: 'PLAN_READY',
            summary: {
                total: diffs.length,
                highRisk: diffs.filter(d => d.risk === 'HIGH').length,
                quarantine: diffs.filter(d => d.action === 'QUARANTINE_TABLE').length
            },
            changes: diffs
        };
    }

    private static async persistMetadataState(client: any, tenantId: string, manifest: MetadataManifest, summary: any) {
        await client.query(`
            INSERT INTO fabric_system.metadata_history (tenant_id, version_tag, ast_content, summary)
            VALUES ($1, $2, $3, $4)
        `, [tenantId, manifest.version, JSON.stringify(manifest), JSON.stringify(summary)]);
    }

    static async getHistory(tenantId: string) {
        const { rows } = await pool.query(`SELECT id, version_tag, summary, applied_at FROM fabric_system.metadata_history WHERE tenant_id = $1 ORDER BY applied_at DESC`, [tenantId]);
        return rows;
    }

    static async rollback(tenantId: string, versionId: string) {
        const { rows } = await pool.query(`SELECT ast_content FROM fabric_system.metadata_history WHERE id = $1 AND tenant_id = $2`, [versionId, tenantId]);
        if (rows.length === 0) throw new Error('Version not found');
        return await this.apply(tenantId, rows[0].ast_content, { force: true });
    }

    private static validateManifest(manifest: MetadataManifest) {
        if (!manifest.version) throw new Error('Industrial Integrity Violation: Manifest version required');
        if (!manifest.schemas || manifest.schemas.length === 0) throw new Error('Industrial Integrity Violation: At least one schema required');
        for (const schema of manifest.schemas) {
            if (!schema.name) throw new Error('Industrial Integrity Violation: Schema name required');
            if (!schema.resources) throw new Error(`Industrial Integrity Violation: Resources required for schema ${schema.name}`);
        }
    }
}
