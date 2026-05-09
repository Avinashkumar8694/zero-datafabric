import { pool } from '../../config/database';
import { MetadataManifest, SchemaDefinition, ResourceDefinition, EnumDefinition, SequenceDefinition, TableDefinition, ViewDefinition, FunctionDefinition } from './types';

export class DiffEngine {
    static async compare(tenantId: string, manifest: MetadataManifest) {
        const diffs: any[] = [];
        const client = await pool.connect();
        
        try {
            for (const schema of manifest.schemas) {
                const schemaName = `tenant_${tenantId}_${schema.name}`;
                
                // 1. Schema Check
                const schemaExists = await client.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [schemaName]);
                if (schemaExists.rows.length === 0) {
                    diffs.push({ action: 'CREATE_SCHEMA', name: schema.name, risk: 'LOW' });
                }

                // 2. Sort Resources by Dependency (DAG)
                const sortedResources = this.sortResources(schema.resources);

                for (const resource of sortedResources) {
                    await this.processResourceDiff(client, schemaName, schema.name, resource, diffs);
                }

                // 3. Relationship Check (Section 8.10)
                if (manifest.relationships) {
                    for (const rel of manifest.relationships) {
                        diffs.push({ action: 'PROVISION_RELATIONSHIP', schema: schema.name, ...rel });
                    }
                }

                // 4. Logical Deletion / Quarantine
                await this.detectRetiredResources(client, schemaName, schema, diffs);
            }

            return diffs;
        } finally {
            client.release();
        }
    }

    private static sortResources(resources: ResourceDefinition[]): ResourceDefinition[] {
        const order = { 'ENUM': 1, 'SEQUENCE': 2, 'FUNCTION': 3, 'PROCEDURE': 3, 'TABLE': 4, 'VIEW': 5, 'MATERIALIZED_VIEW': 6 };
        return [...resources].sort((a, b) => (order[a.type] || 99) - (order[b.type] || 99));
    }

    private static async processResourceDiff(client: any, schemaName: string, shortSchemaName: string, resource: ResourceDefinition, diffs: any[]) {
        switch (resource.type) {
            case 'ENUM':
                await this.diffEnum(client, schemaName, shortSchemaName, resource, diffs);
                break;
            case 'SEQUENCE':
                await this.diffSequence(client, schemaName, shortSchemaName, resource, diffs);
                break;
            case 'TABLE':
                await this.diffTable(client, schemaName, shortSchemaName, resource, diffs);
                break;
            case 'VIEW':
            case 'MATERIALIZED_VIEW':
                await this.diffView(client, schemaName, shortSchemaName, resource, diffs);
                break;
            case 'FUNCTION':
            case 'PROCEDURE':
                await this.diffFunction(client, schemaName, shortSchemaName, resource, diffs);
                break;
        }
    }

    private static async diffEnum(client: any, schemaName: string, shortSchemaName: string, res: EnumDefinition, diffs: any[]) {
        const exists = await client.query(`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_ENUM', schema: shortSchemaName, ...res, risk: 'LOW' });
        }
    }

    private static async diffSequence(client: any, schemaName: string, shortSchemaName: string, res: SequenceDefinition, diffs: any[]) {
        const exists = await client.query(`SELECT 1 FROM information_schema.sequences WHERE sequence_schema = $1 AND sequence_name = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_SEQUENCE', schema: shortSchemaName, ...res, risk: 'LOW' });
        }
    }

    private static async diffTable(client: any, schemaName: string, shortSchemaName: string, res: TableDefinition, diffs: any[]) {
        const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_TABLE', schema: shortSchemaName, ...res, risk: 'LOW' });
        } else {
            // Detect Column Additions/Modifications
            for (const col of res.columns) {
                const colExists = await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`, [schemaName, res.name, col.name]);
                if (colExists.rows.length === 0) {
                    diffs.push({ action: 'ADD_COLUMN', schema: shortSchemaName, table: res.name, column: col, risk: 'LOW' });
                }
            }
        }
    }

    private static async diffView(client: any, schemaName: string, shortSchemaName: string, res: ViewDefinition, diffs: any[]) {
        const type = res.type === 'VIEW' ? 'VIEW' : 'MATERIALIZED VIEW';
        // Simplified check
        const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_VIEW', schema: shortSchemaName, ...res, risk: 'LOW' });
        }
    }

    private static async diffFunction(client: any, schemaName: string, shortSchemaName: string, res: FunctionDefinition, diffs: any[]) {
        const exists = await client.query(`SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2`, [schemaName, res.name]);
        if (exists.rows.length === 0) {
            diffs.push({ action: 'CREATE_FUNCTION', schema: shortSchemaName, ...res, risk: 'LOW' });
        }
    }

    private static async detectRetiredResources(client: any, schemaName: string, schema: SchemaDefinition, diffs: any[]) {
        const { rows: liveTables } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]);
        const astTableNames = schema.resources.filter(r => r.type === 'TABLE').map(r => r.name);
        for (const live of liveTables) {
            if (!astTableNames.includes(live.table_name) && !live.table_name.startsWith('__deleted')) {
                diffs.push({ action: 'QUARANTINE_TABLE', schema: schema.name, table: live.table_name, risk: 'MEDIUM' });
            }
        }
    }
}
