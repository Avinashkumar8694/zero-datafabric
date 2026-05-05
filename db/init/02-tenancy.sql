-- Advanced Tenancy & Provisioning Logic

CREATE OR REPLACE FUNCTION fabric_admin.create_tenant_namespace(p_tenant_id TEXT)
RETURNS VOID AS $$
DECLARE
    v_schema_name TEXT := 'tenant_' || p_tenant_id;
BEGIN
    -- Create isolated schema
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema_name);
    
    -- Set default permissions
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO fabric_user', v_schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabric_user', v_schema_name);
    
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
    p_pass TEXT
) RETURNS VOID AS $$
DECLARE
    v_server_name TEXT := 'server_' || p_tenant_id || '_' || p_source_name;
    v_schema_name TEXT := 'tenant_' || p_tenant_id;
BEGIN
    -- Create Foreign Server
    EXECUTE format('CREATE SERVER IF NOT EXISTS %I 
                    FOREIGN DATA WRAPPER postgres_fdw 
                    OPTIONS (host %L, port %L, dbname %L)', 
                    v_server_name, p_host, p_port::text, p_db_name);
    
    -- Create User Mapping
    EXECUTE format('CREATE USER MAPPING IF NOT EXISTS FOR current_user 
                    SERVER %I 
                    OPTIONS (user %L, password %L)', 
                    v_server_name, p_user, p_pass);
    
    -- Import remote schema into tenant namespace
    EXECUTE format('IMPORT FOREIGN SCHEMA public FROM SERVER %I INTO %I', 
                    v_server_name, v_schema_name);

    RAISE NOTICE 'Successfully integrated remote source % for tenant %', p_source_name, p_tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
