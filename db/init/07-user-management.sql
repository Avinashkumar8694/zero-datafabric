-- Module 3.1: Industrial User Management
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    tenant_id VARCHAR(255) REFERENCES public.tenants(id),
    role VARCHAR(50) DEFAULT 'USER',
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Provision Initial Management Tenant
INSERT INTO public.tenants (id, name) VALUES ('tenant_A', 'System Admin') ON CONFLICT (id) DO NOTHING;

-- Seed an Industrial Admin User
-- Password is 'admin'
INSERT INTO public.users (username, password_hash, tenant_id, role)
VALUES ('admin', '$2b$10$CxBK2AyOtIyt4hCsEZPqEOhGQloahPxyalyChP9hNprweiD/4PZY2', 'tenant_A', 'ADMIN')
ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Enable RLS on users
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_isolation_policy ON public.users;
CREATE POLICY user_isolation_policy ON public.users
    USING (
        tenant_id::text = current_setting('app.tenant_id', true)::text 
        OR tenant_id::text = (current_setting('request.jwt.claims', true)::json->>'tenant_id')
        OR (current_setting('request.jwt.claims', true)::json->>'internal_role' = 'ADMIN')
        OR current_user = 'fabric_admin'
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO fabric_user;
