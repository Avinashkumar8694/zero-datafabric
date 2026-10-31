-- 20: FDW / remote-source hardening (idempotent; safe to re-run).
--
-- Problems fixed (see MULTITENANCY_PLAN.md item 6):
--  1. FDW server names were 'server_'||tenant||'_'||source, so tenant `a` + source `b_c` and tenant `a_b` + source `c`
--     shared one server (and `DROP SERVER ... CASCADE` on re-register/remove destroyed the other tenant's tables).
--     New scheme: fabric_admin.fdw_server_name() = 'server_<tenant>__<source>' (double-underscore delimiter), switching to
--     a truncated + hashed form when the name would not fit 63 chars or the parts themselves contain '__'.
--     Ownership of every server is recorded in fabric_admin.fdw_servers; a name that is already taken by a different
--     (tenant, source) is an error instead of a silent overwrite.
--  2. IMPORT FOREIGN SCHEMA used an EXCEPT blacklist that missed settings, saved_analytics, query_logs, api_tokens,
--     fabric_worker_*, ... Now ONLY an explicit allow-list is imported (`LIMIT TO (...)`), computed from the remote's
--     actual user tables and never including platform tables (static list + every table that exists in this hub's `public`).
--  3. Inputs are validated and everything uses format('%I' / '%L').
--
-- Compatibility: servers registered under the old scheme keep working. They are recorded in the registry (scheme 'v1')
-- when exactly one data source maps to the legacy name; re-registering / removing such a source migrates / drops it.
-- Ambiguous legacy servers (several sources map to one name) are left untouched.
-- The application (owner role) calls these functions; fabric_user must not be able to (belt and braces with 19-*.sql).

CREATE TABLE IF NOT EXISTS fabric_admin.fdw_servers (
    server_name TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    source_name TEXT NOT NULL,
    scheme      TEXT NOT NULL DEFAULT 'v2',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_name)
);
REVOKE ALL ON fabric_admin.fdw_servers FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN
    EXECUTE 'REVOKE ALL ON fabric_admin.fdw_servers FROM fabric_user';
END IF; END $$;

-- Collision-free server name -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fabric_admin.fdw_server_name(p_tenant_id TEXT, p_source_name TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
    v_plain TEXT;
BEGIN
    IF p_tenant_id IS NULL OR p_source_name IS NULL THEN
        RAISE EXCEPTION 'tenant id and source name are required';
    END IF;
    v_plain := 'server_' || p_tenant_id || '__' || p_source_name;
    -- plain form only when it is unambiguous (neither part contains the delimiter) and fits an identifier
    IF length(v_plain) <= 63 AND position('__' IN p_tenant_id) = 0 AND position('__' IN p_source_name) = 0 THEN
        RETURN v_plain;
    END IF;
    RETURN 'server_' || left(p_tenant_id, 16) || '__' || left(p_source_name, 16) || '__' ||
           substr(md5(p_tenant_id || chr(31) || p_source_name), 1, 16);
END;
$$;

-- The pre-hardening name (kept only to find / migrate servers created by older versions)
CREATE OR REPLACE FUNCTION fabric_admin.fdw_legacy_server_name(p_tenant_id TEXT, p_source_name TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT 'server_' || p_tenant_id || '_' || p_source_name;
$$;

-- Platform tables that must never be imported from a remote that happens to be (or look like) a hub. Static names plus
-- every relation that exists in this hub's `public` schema.
CREATE OR REPLACE FUNCTION fabric_admin.fdw_platform_tables()
RETURNS TEXT[] LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
    v_static TEXT[] := ARRAY[
        'citus_schemas','citus_tables','citus_shards','citus_shard_placements','pg_stat_statements','pg_stat_statements_info',
        'data_sources','tenants','audit_logs','users','catalog_schemas','catalog_tables','metadata_catalog','discovery_catalog',
        'discovery_fields','docs_posts','es_mutation_jobs','fabric_docs','notification_channels','plans','subscriptions',
        'trigger_execution_logs','trigger_jobs','trigger_registry','discovery_tree_view','settings','saved_analytics','query_logs',
        'api_tokens','fabric_worker_nodes','fabric_worker_events','migrations','typeorm_metadata','schema_migrations',
        'user_plans','tenant_limits','query_log','job_queue_items','scheduled_jobs','scheduled_job_runs'
    ];
    v_local TEXT[];
BEGIN
    SELECT COALESCE(array_agg(c.relname::text), ARRAY[]::text[]) INTO v_local
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f');
    RETURN v_static || v_local;
END;
$$;

-- Registration ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fabric_admin.register_remote_source(
    p_tenant_id TEXT,
    p_source_name TEXT,
    p_host TEXT,
    p_port INT,
    p_db_name TEXT,
    p_user TEXT,
    p_pass TEXT,
    p_connection_string TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_server      TEXT;
    v_schema_name TEXT;
    v_existing    RECORD;
    v_probe       TEXT;
    v_tables      TEXT[];
    v_platform    TEXT[];
    v_list        TEXT;
    v_legacy      TEXT;
    v_legacy_owner INT;
BEGIN
    -- 1. input validation ------------------------------------------------------------------------------------------
    IF p_tenant_id IS NULL OR p_tenant_id !~ '^[A-Za-z][A-Za-z0-9_]{1,40}$' THEN
        RAISE EXCEPTION 'invalid tenant id' USING ERRCODE = '22023';
    END IF;
    IF p_source_name IS NULL OR p_source_name !~ '^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$' THEN
        RAISE EXCEPTION 'invalid source name' USING ERRCODE = '22023';
    END IF;
    IF p_connection_string IS NULL THEN
        IF p_host IS NULL OR p_host !~ '^[A-Za-z0-9._:-]{1,255}$' THEN
            RAISE EXCEPTION 'invalid host' USING ERRCODE = '22023';
        END IF;
        IF p_port IS NULL OR p_port < 1 OR p_port > 65535 THEN
            RAISE EXCEPTION 'invalid port' USING ERRCODE = '22023';
        END IF;
        IF p_db_name IS NULL OR length(p_db_name) = 0 OR length(p_db_name) > 63 THEN
            RAISE EXCEPTION 'invalid database name' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF length(p_connection_string) > 2048 OR p_connection_string ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' THEN
            RAISE EXCEPTION 'invalid connection string' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF p_user IS NOT NULL AND (length(p_user) > 128) THEN
        RAISE EXCEPTION 'invalid user' USING ERRCODE = '22023';
    END IF;
    IF p_pass IS NOT NULL AND (length(p_pass) > 1024) THEN
        RAISE EXCEPTION 'invalid password' USING ERRCODE = '22023';
    END IF;

    -- 2. refuse the hub itself (the application checks first and may opt in with fabric.allow_hub_source) ------------
    IF COALESCE(current_setting('fabric.allow_hub_source', true), '') <> 'on'
       AND p_connection_string IS NULL
       AND p_db_name = current_database()
       AND lower(p_host) IN ('localhost', '127.0.0.1', '::1', '0.0.0.0', 'db', 'datafabric-hub', 'datafabric_hub')
       AND p_port IN (5432, COALESCE(inet_server_port(), 5432)) THEN
        RAISE EXCEPTION 'the platform hub database cannot be registered as a data source' USING ERRCODE = '42501';
    END IF;

    v_server      := fabric_admin.fdw_server_name(p_tenant_id, p_source_name);
    v_schema_name := 'tenant_' || p_tenant_id;
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = v_schema_name) THEN
        RAISE EXCEPTION 'tenant namespace % does not exist', v_schema_name USING ERRCODE = '3F000';
    END IF;

    -- 3. ownership: never touch a server that belongs to another (tenant, source) -------------------------------------
    SELECT * INTO v_existing FROM fabric_admin.fdw_servers WHERE server_name = v_server;
    IF FOUND AND (v_existing.tenant_id <> p_tenant_id OR v_existing.source_name <> p_source_name) THEN
        RAISE EXCEPTION 'foreign server name % is already used by another source', v_server USING ERRCODE = '42710';
    END IF;
    IF NOT FOUND AND EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = v_server) THEN
        RAISE EXCEPTION 'foreign server name % collides with an existing server', v_server USING ERRCODE = '42710';
    END IF;

    -- 4. re-registration: drop what THIS source owned (new scheme or a migrated legacy server) -------------------------
    FOR v_existing IN SELECT server_name FROM fabric_admin.fdw_servers WHERE tenant_id = p_tenant_id AND source_name = p_source_name LOOP
        EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_existing.server_name);
        DELETE FROM fabric_admin.fdw_servers WHERE server_name = v_existing.server_name;
    END LOOP;
    -- legacy server not (yet) in the registry: migrate only when this source is its single owner
    v_legacy := fabric_admin.fdw_legacy_server_name(p_tenant_id, p_source_name);
    IF EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = v_legacy) THEN
        SELECT count(*) INTO v_legacy_owner FROM public.data_sources ds
         WHERE lower(ds.type) IN ('postgres', 'postgresql') AND fabric_admin.fdw_legacy_server_name(ds.tenant_id, ds.name) = v_legacy;
        IF v_legacy_owner = 1 THEN
            EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_legacy);
        ELSE
            RAISE NOTICE 'legacy server % is shared by several sources and is left untouched', v_legacy;
        END IF;
    END IF;

    -- 5. create server + user mapping -----------------------------------------------------------------------------------
    IF p_connection_string IS NOT NULL THEN
        EXECUTE format('CREATE SERVER %I FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname %L)', v_server, p_connection_string);
    ELSE
        EXECUTE format('CREATE SERVER %I FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host %L, port %L, dbname %L)',
                       v_server, p_host, p_port::text, p_db_name);
    END IF;
    INSERT INTO fabric_admin.fdw_servers (server_name, tenant_id, source_name, scheme) VALUES (v_server, p_tenant_id, p_source_name, 'v2');

    IF p_user IS NOT NULL AND p_pass IS NOT NULL THEN
        EXECUTE format('CREATE USER MAPPING FOR current_user SERVER %I OPTIONS (user %L, password %L)', v_server, p_user, p_pass);
    ELSE
        EXECUTE format('CREATE USER MAPPING FOR current_user SERVER %I', v_server);
    END IF;

    -- 6. allow-list: the remote's actual user tables/views minus platform tables --------------------------------------
    v_probe := 'fdw_probe_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12);
    EXECUTE format('CREATE FOREIGN TABLE pg_temp.%I (table_schema text, table_name text, table_type text) SERVER %I OPTIONS (schema_name %L, table_name %L)',
                   v_probe, v_server, 'information_schema', 'tables');
    v_platform := fabric_admin.fdw_platform_tables();
    EXECUTE format($q$
        SELECT COALESCE(array_agg(t.table_name ORDER BY t.table_name), ARRAY[]::text[]) FROM (
            SELECT DISTINCT table_name FROM pg_temp.%I
             WHERE table_schema = 'public'
               AND table_type IN ('BASE TABLE', 'VIEW')
               AND table_name !~ '^(pg_|citus|_)'
               AND NOT (table_name = ANY ($1))
             LIMIT 500
        ) t$q$, v_probe) INTO v_tables USING v_platform;
    EXECUTE format('DROP FOREIGN TABLE pg_temp.%I', v_probe);

    IF array_length(v_tables, 1) IS NULL THEN
        RAISE NOTICE 'remote source % exposes no importable tables', p_source_name;
    ELSE
        SELECT string_agg(format('%I', x), ', ') INTO v_list FROM unnest(v_tables) AS x;
        EXECUTE format('IMPORT FOREIGN SCHEMA public LIMIT TO (%s) FROM SERVER %I INTO %I', v_list, v_server, v_schema_name);
    END IF;

    RAISE NOTICE 'Successfully integrated remote source % for tenant % (% table(s))', p_source_name, p_tenant_id, COALESCE(array_length(v_tables, 1), 0);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Removal --------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fabric_admin.remove_remote_source(
    p_tenant_id TEXT,
    p_source_name TEXT
) RETURNS VOID AS $$
DECLARE
    v_row    RECORD;
    v_legacy TEXT;
    v_owners INT;
BEGIN
    IF p_tenant_id IS NULL OR p_tenant_id !~ '^[A-Za-z][A-Za-z0-9_]{1,40}$' THEN
        RAISE EXCEPTION 'invalid tenant id' USING ERRCODE = '22023';
    END IF;
    IF p_source_name IS NULL OR p_source_name !~ '^[A-Za-z]([A-Za-z0-9 _-]{0,46}[A-Za-z0-9_-])?$' THEN
        RAISE EXCEPTION 'invalid source name' USING ERRCODE = '22023';
    END IF;

    -- exactly the server(s) this (tenant, source) owns
    FOR v_row IN SELECT server_name FROM fabric_admin.fdw_servers WHERE tenant_id = p_tenant_id AND source_name = p_source_name LOOP
        EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_row.server_name);
        DELETE FROM fabric_admin.fdw_servers WHERE server_name = v_row.server_name;
    END LOOP;

    -- legacy server that predates the registry: only when this source is its single owner
    v_legacy := fabric_admin.fdw_legacy_server_name(p_tenant_id, p_source_name);
    IF EXISTS (SELECT 1 FROM pg_foreign_server WHERE srvname = v_legacy) THEN
        SELECT count(*) INTO v_owners FROM public.data_sources ds
         WHERE lower(ds.type) IN ('postgres', 'postgresql') AND fabric_admin.fdw_legacy_server_name(ds.tenant_id, ds.name) = v_legacy;
        IF v_owners <= 1 THEN
            EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_legacy);
        ELSE
            RAISE NOTICE 'legacy server % is shared by several sources and is left untouched', v_legacy;
        END IF;
    END IF;

    RAISE NOTICE 'Successfully removed remote source % for tenant %', p_source_name, p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

-- Backfill the registry for servers created by older versions (single-owner legacy names only) ---------------------------
INSERT INTO fabric_admin.fdw_servers (server_name, tenant_id, source_name, scheme)
SELECT fabric_admin.fdw_legacy_server_name(ds.tenant_id, ds.name), ds.tenant_id, ds.name, 'v1'
  FROM public.data_sources ds
  JOIN pg_foreign_server fs ON fs.srvname = fabric_admin.fdw_legacy_server_name(ds.tenant_id, ds.name)
 WHERE lower(ds.type) IN ('postgres', 'postgresql')
   AND (SELECT count(*) FROM public.data_sources d2
         WHERE lower(d2.type) IN ('postgres', 'postgresql')
           AND fabric_admin.fdw_legacy_server_name(d2.tenant_id, d2.name) = fabric_admin.fdw_legacy_server_name(ds.tenant_id, ds.name)) = 1
ON CONFLICT DO NOTHING;

-- The app calls these as the owner; nobody else (idempotent with 19-*.sql) -----------------------------------------------
REVOKE ALL ON FUNCTION fabric_admin.register_remote_source(TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fabric_admin.remove_remote_source(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fabric_admin.fdw_server_name(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fabric_admin.fdw_legacy_server_name(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fabric_admin.fdw_platform_tables() FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabric_user') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION fabric_admin.register_remote_source(TEXT, TEXT, TEXT, INT, TEXT, TEXT, TEXT, TEXT) FROM fabric_user';
    EXECUTE 'REVOKE ALL ON FUNCTION fabric_admin.remove_remote_source(TEXT, TEXT) FROM fabric_user';
    EXECUTE 'REVOKE ALL ON FUNCTION fabric_admin.fdw_server_name(TEXT, TEXT) FROM fabric_user';
    EXECUTE 'REVOKE ALL ON FUNCTION fabric_admin.fdw_legacy_server_name(TEXT, TEXT) FROM fabric_user';
    EXECUTE 'REVOKE ALL ON FUNCTION fabric_admin.fdw_platform_tables() FROM fabric_user';
END IF; END $$;
