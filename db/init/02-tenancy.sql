-- Advanced Tenancy & Provisioning Logic

CREATE OR REPLACE FUNCTION fabric_admin.create_tenant_namespace(p_tenant_id TEXT)
RETURNS VOID AS $$
DECLARE
    v_schema_name TEXT := 'tenant_' || p_tenant_id;
BEGIN
    -- Create isolated schema
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema_name);
    EXECUTE format('CREATE SCHEMA %I', v_schema_name);
    
    -- Set default permissions
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO fabric_user', v_schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user', v_schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO fabric_user', v_schema_name);
    
    RAISE NOTICE 'Provisioned namespace for tenant %', p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Foreign Data Wrapper Registration Function
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
    v_server_name TEXT := 'server_' || p_tenant_id || '_' || p_source_name;
    v_schema_name TEXT := 'tenant_' || p_tenant_id;
BEGIN
    -- Cleanup existing server if re-registering
    EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_server_name);

    -- Create Foreign Server
    IF p_connection_string IS NOT NULL THEN
        EXECUTE format('CREATE SERVER IF NOT EXISTS %I 
                        FOREIGN DATA WRAPPER postgres_fdw 
                        OPTIONS (dbname %L)', 
                        v_server_name, p_connection_string);
    ELSE
        EXECUTE format('CREATE SERVER IF NOT EXISTS %I 
                        FOREIGN DATA WRAPPER postgres_fdw 
                        OPTIONS (host %L, port %L, dbname %L)', 
                        v_server_name, p_host, p_port::text, p_db_name);
    END IF;
    
    -- Create User Mapping
    IF p_user IS NOT NULL AND p_pass IS NOT NULL THEN
        EXECUTE format('CREATE USER MAPPING IF NOT EXISTS FOR current_user 
                        SERVER %I 
                        OPTIONS (user %L, password %L)', 
                        v_server_name, p_user, p_pass);
    ELSE
        EXECUTE format('CREATE USER MAPPING IF NOT EXISTS FOR current_user 
                        SERVER %I', 
                        v_server_name);
    END IF;
    
    -- Import remote schema into tenant namespace (Excluding system and core fabric tables)
    EXECUTE format('IMPORT FOREIGN SCHEMA public EXCEPT (citus_schemas, citus_tables, pg_stat_statements, pg_stat_statements_info, data_sources, tenants, audit_logs, users, catalog_schemas, catalog_tables, metadata_catalog, discovery_catalog, discovery_fields, docs_posts, es_mutation_jobs, fabric_docs, notification_channels, plans, subscriptions, trigger_execution_logs, trigger_jobs, trigger_registry, discovery_tree_view) FROM SERVER %I INTO %I', 
                    v_server_name, v_schema_name);

    RAISE NOTICE 'Successfully integrated remote source % for tenant %', p_source_name, p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Foreign Data Wrapper Removal Function
CREATE OR REPLACE FUNCTION fabric_admin.remove_remote_source(
    p_tenant_id TEXT,
    p_source_name TEXT
) RETURNS VOID AS $$
DECLARE
    v_server_name TEXT := 'server_' || p_tenant_id || '_' || p_source_name;
    v_schema_name TEXT := 'tenant_' || p_tenant_id;
BEGIN
    -- 1. Drop Foreign Server (Cascades to User Mappings and Foreign Tables)
    EXECUTE format('DROP SERVER IF EXISTS %I CASCADE', v_server_name);
    
    RAISE NOTICE 'Successfully removed remote source % for tenant %', p_source_name, p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
