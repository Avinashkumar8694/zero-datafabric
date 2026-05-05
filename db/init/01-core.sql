-- Core Database Foundation
-- Enable Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgres_fdw";
CREATE EXTENSION IF NOT EXISTS "citus";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Security Roles for PostgREST
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'super_secret_password';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'web_anon') THEN
    CREATE ROLE web_anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'fabric_user') THEN
    CREATE ROLE fabric_user NOLOGIN;
  END IF;
END $$;

GRANT web_anon TO authenticator;
GRANT fabric_user TO authenticator;

-- Administrative Schema for Orchestration
CREATE SCHEMA IF NOT EXISTS fabric_admin;
GRANT USAGE ON SCHEMA fabric_admin TO fabric_user;

-- Tenant Registry
CREATE TABLE IF NOT EXISTS public.tenants (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tier VARCHAR(50) DEFAULT 'STANDARD',
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Data Source Registry
CREATE TABLE IF NOT EXISTS public.data_sources (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id VARCHAR(255) REFERENCES public.tenants(id),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    config JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'CONNECTED',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Enable RLS on core registries
ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON public.data_sources
    USING (tenant_id = current_setting('request.jwt.claims', true)::json->>'tenant_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.data_sources TO fabric_user;
GRANT SELECT ON public.tenants TO fabric_user;
