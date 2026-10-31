import { spawnSync } from 'child_process';
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../../index';
import { pool } from '../../config/database';
import { CleanupService } from '../../services/cleanup.service';

export const getAdminToken = async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin' });
    return res.body.token;
};

/**
 * A tenant id that satisfies assertTenantId (`^[A-Za-z][A-Za-z0-9_]{1,40}$`) and the no-overlap rule: the prefix is
 * a short fixed word (never an existing tenant id followed by `_`) and every call gets a unique suffix.
 */
export const uniqueTenantId = (prefix = 'tt') => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`.slice(0, 40);

/** Remove everything a test tenant owns (registry rows, catalog, data sources, schemas, users, the tenant row). Never throws. */
export const cleanupTenant = async (tenantId: string) => {
    const attempt = async (sql: string, params: any[] = [tenantId]) => {
        try { await pool.query(sql, params); } catch (e: any) {
            if (e.code !== '42P01' && e.code !== '3F000') console.warn(`[Test Helper] cleanup step failed (${sql.slice(0, 60)}): ${e.message}`); // missing tables are fine on partial installs
        }
    };
    try {
        // Foreign servers of VIRTUAL postgres sources first (the product's own remover), then any server still carrying this tenant's prefix.
        const { rows: pgSources } = await pool.query(`SELECT name FROM public.data_sources WHERE tenant_id = $1 AND type = 'postgres'`, [tenantId]).catch(() => ({ rows: [] as any[] }));
        for (const src of pgSources) await attempt('SELECT fabric_admin.remove_remote_source($1, $2)', [tenantId, src.name]);
        const { rows: servers } = await pool.query(
            `SELECT srvname FROM pg_foreign_server WHERE srvname LIKE $1`, [`server\\_${tenantId.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_\\_%`]
        ).catch(() => ({ rows: [] as any[] }));
        for (const sv of servers) await attempt(`DROP SERVER IF EXISTS "${String(sv.srvname).replace(/"/g, '""')}" CASCADE`, []);

        await CleanupService.purgeTenant(tenantId); // catalog, data sources, jobs, logs and schemas (it recreates an empty namespace)
        for (const sql of [
            'DELETE FROM public.notification_channels WHERE tenant_id = $1',
            'DELETE FROM public.trigger_registry WHERE tenant_id = $1',
            'DELETE FROM public.trigger_jobs WHERE tenant_id = $1',
            'DELETE FROM public.es_mutation_jobs WHERE tenant_id = $1',
            'DELETE FROM public.api_tokens WHERE tenant_id = $1',
            'DELETE FROM fabric_system.access_policies WHERE tenant_id = $1',
            'DELETE FROM fabric_system.access_grants WHERE tenant_id = $1',
            'DELETE FROM fabric_system.fabric_constraints WHERE tenant_id = $1',
            'DELETE FROM fabric_system.metadata_history WHERE tenant_id = $1',
            'DELETE FROM fabric_system.downstream_registry WHERE tenant_id = $1',
        ]) await attempt(sql);
        const likeSchemas = `tenant_${tenantId.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_%`;
        await attempt('DELETE FROM fabric_catalog.metadata WHERE schema_name = $1 OR schema_name LIKE $2', [`tenant_${tenantId}`, likeSchemas]);
        await attempt('DELETE FROM public.catalog_schemas WHERE source_id IS NULL AND (physical_name = $1 OR physical_name LIKE $2)', [`tenant_${tenantId}`, likeSchemas]);

        // purgeTenant re-creates the primary namespace, so drop the schemas last (exact names only, never a LIKE prefix).
        const { rows } = await pool.query(
            `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1 OR schema_name LIKE $2 ESCAPE '\\'`,
            [`tenant_${tenantId}`, `tenant\\_${tenantId.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_%`]
        );
        for (const r of rows) await pool.query(`DROP SCHEMA IF EXISTS "${String(r.schema_name).replace(/"/g, '""')}" CASCADE`);

        // users reference tenants (users.tenant_id FK): remove the users first, then the tenant row.
        await pool.query('DELETE FROM public.users WHERE tenant_id = $1', [tenantId]);
        await pool.query('DELETE FROM public.tenants WHERE id = $1', [tenantId]);
    } catch (err: any) {
        console.error(`[Test Helper] Error during cleanupTenant for ${tenantId}:`, err.message);
    }
};

/** Create a tenant through the real API (platform admin) and return a tenant-scoped admin token. */
export const createTenantViaApi = async (adminToken: string, id: string, name: string) => {
    const res = await request(app).post('/api/admin/tenants').set('Authorization', `Bearer ${adminToken}`).send({ id, name });
    if (res.status !== 201) throw new Error(`Tenant creation failed for ${id}: ${res.status} ${JSON.stringify(res.body)}`);
    const tokenRes = await request(app).post('/api/auth/token').set('Authorization', `Bearer ${adminToken}`).send({ tenantId: id });
    return tokenRes.body.token as string;
};

/* ------------------------- external infrastructure probes ------------------------- */

/** Synchronous TCP probe (500 ms timeout) so a describe block can be skipped while the suite is being collected. */
export const isReachable = (host: string, port: number, timeoutMs = 500): boolean => {
    const script = `const s=require('net').connect({host:${JSON.stringify(host)},port:${Number(port)}});` +
        `const t=setTimeout(()=>process.exit(1),${timeoutMs});s.on('connect',()=>{clearTimeout(t);process.exit(0)});s.on('error',()=>process.exit(1));`;
    return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1500 }).status === 0;
};

/**
 * `describeIfReachable('mysql', host, port)('Suite name', () => { ... })`: runs the suite only when `host:port` accepts a TCP
 * connection, otherwise the suite is skipped and one line says why (the test is kept, never deleted).
 */
export const describeIfReachable = (label: string, host: string, port: number): jest.Describe => {
    if (isReachable(host, port)) return describe;
    process.stderr.write(`[skip] ${label} unreachable at ${host}:${port}; suites needing it are skipped\n`);
    return describe.skip as unknown as jest.Describe;
};

/** The "remote warehouse" Postgres used by virtualization tests (docker-compose publishes it on 5436; override with REMOTE_PG_HOST/PORT). */
export const REMOTE_PG = {
    host: process.env.REMOTE_PG_HOST || '127.0.0.1',
    port: Number(process.env.REMOTE_PG_PORT || 5436),
    dbName: 'remote_warehouse',
    user: 'remote_admin',
    pass: 'remote_password',
};
export const describeIfRemotePg = (): jest.Describe => describeIfReachable('remote postgres', REMOTE_PG.host, REMOTE_PG.port);

/** Run `fn` with a client connected to the remote warehouse Postgres (test fixtures such as seed tables live there). */
export const withRemotePg = async <T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> => {
    const { Client } = require('pg') as typeof import('pg');
    const c = new Client({ host: REMOTE_PG.host, port: REMOTE_PG.port, database: REMOTE_PG.dbName, user: REMOTE_PG.user, password: REMOTE_PG.pass });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
};

/** Connection config for registering the remote warehouse as a VIRTUAL postgres source. */
export const remotePgConfig = (syncType: 'VIRTUAL' | 'SYNC' = 'VIRTUAL') => ({
    type: 'postgres', host: REMOTE_PG.host, port: REMOTE_PG.port, dbName: REMOTE_PG.dbName, user: REMOTE_PG.user, pass: REMOTE_PG.pass, syncType,
});
