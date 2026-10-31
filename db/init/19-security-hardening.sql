-- 19-security-hardening.sql  (multi-tenancy isolation hardening; idempotent, safe to re-run on an existing DB)
--
-- The application itself connects as the owner (fabric_admin) pool; `queryWithContext` only does SET LOCAL ROLE
-- fabric_user for statements that carry tenant-supplied SQL shapes. Everything below removes privileges that
-- fabric_user (and PUBLIC) held without needing them. Every statement is guarded so a partially provisioned
-- database (e.g. an object that does not exist yet) never aborts the script.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. fabric_admin SECURITY DEFINER functions (create_tenant_namespace, register_remote_source, remove_remote_source,
--    audit_trigger_func, ...) are callable only by the owner. They used to be executable by PUBLIC, so any tenant
--    could `CALL fabric_admin.create_tenant_namespace('<victim>')` (DROP SCHEMA ... CASCADE) or re-register FDW servers.
--    The application invokes them through the owner pool, never as fabric_user.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  IF to_regnamespace('fabric_admin') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
     WHERE p.pronamespace = 'fabric_admin'::regnamespace
       AND p.prosecdef
       AND p.prokind IN ('f', 'p')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM fabric_user', r.sig);
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticator', r.sig); EXCEPTION WHEN undefined_object THEN NULL; END;
    BEGIN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM web_anon', r.sig);      EXCEPTION WHEN undefined_object THEN NULL; END;
  END LOOP;
  -- functions created later in fabric_admin (by the role running this script) are not executable by PUBLIC either
  ALTER DEFAULT PRIVILEGES IN SCHEMA fabric_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. public.users: fabric_user can neither read password hashes nor self-promote (UPDATE users SET role='ADMIN').
--    All user management goes through the owner pool (AuthService).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    REVOKE ALL ON public.users FROM PUBLIC;
    REVOKE ALL ON public.users FROM fabric_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. public.audit_logs is a view over fabric_admin.audit_logs. It ran with the view OWNER's rights (superuser, which
--    bypasses RLS), so a member selecting from it saw every workspace's audit trail. security_invoker makes the
--    base table's tenant RLS policy (audit_isolation_policy) apply to the caller.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.audit_logs') IS NOT NULL
     AND (SELECT relkind FROM pg_class WHERE oid = 'public.audit_logs'::regclass) = 'v' THEN
    EXECUTE 'ALTER VIEW public.audit_logs SET (security_invoker = true)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Catalog tables were GRANT ALL ... TO PUBLIC. The application only READS them as fabric_user (all writes go
--    through the owner pool), so: no PUBLIC access, read-only for fabric_user. Queries are tenant-scoped in the
--    application layer (these tables carry no tenant column / RLS policy of their own).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.catalog_schemas', 'public.catalog_tables', 'fabric_catalog.relationships',
                           'fabric_catalog.metadata', 'fabric_catalog.quality_metrics']
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', t);
      EXECUTE format('REVOKE ALL ON %s FROM fabric_user', t);
      EXECUTE format('GRANT SELECT ON %s TO fabric_user', t);
    END IF;
  END LOOP;
  IF to_regnamespace('fabric_catalog') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA fabric_catalog FROM PUBLIC;
    GRANT USAGE ON SCHEMA fabric_catalog TO fabric_user;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA fabric_catalog FROM PUBLIC;
  END IF;
  IF to_regclass('public.metadata_catalog') IS NOT NULL THEN
    REVOKE ALL ON public.metadata_catalog FROM PUBLIC;
    GRANT SELECT ON public.metadata_catalog TO fabric_user;
  END IF;
END $$;

-- fabric_catalog.metadata tenant policy: exact tenant schema (tenant_<id> or tenant_<id>_<logical>) instead of
-- LIKE 'tenant_<id>%' (prefix collisions between tenants, and `_` / `%` in ids acting as wildcards).
DO $$
BEGIN
  IF to_regclass('fabric_catalog.metadata') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_metadata_policy ON fabric_catalog.metadata';
    EXECUTE $p$CREATE POLICY tenant_metadata_policy ON fabric_catalog.metadata
      USING (
        schema_name = 'tenant_' || current_setting('app.tenant_id', true)
        OR starts_with(schema_name, 'tenant_' || current_setting('app.tenant_id', true) || '_')
      )$p$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. fabric_system (orchestration history, policies, grants, query logs, job queues) is control-plane state with no
--    RLS: fabric_user never needs it (the app reads/writes it through the owner pool, always filtered by tenant_id).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('fabric_system') IS NOT NULL THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA fabric_system FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA fabric_system FROM fabric_user;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA fabric_system FROM fabric_user;
    REVOKE ALL ON SCHEMA fabric_system FROM PUBLIC;
    REVOKE ALL ON SCHEMA fabric_system FROM fabric_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Statistics views that expose other tenants' SQL text / sharding layout are readable by PUBLIC by default.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.pg_stat_statements', 'public.pg_stat_statements_info', 'public.citus_tables', 'public.citus_schemas']
  LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', t);
      EXECUTE format('REVOKE ALL ON %s FROM fabric_user', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Diagnostic only: tenant ids that overlap (X starts with E || '_') make `tenant_<id>_<logical>` schema names
--    ambiguous. New tenants are rejected at creation (409 TENANT_ID_OVERLAP); pre-existing overlaps are reported here.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN RETURN; END IF;
  FOR r IN
    SELECT a.id AS short_id, b.id AS long_id
      FROM public.tenants a JOIN public.tenants b
        ON lower(a.id) <> lower(b.id) AND left(lower(b.id), length(a.id) + 1) = lower(a.id) || '_'
  LOOP
    RAISE NOTICE 'tenant id overlap: "%" is a "_"-prefix of "%" (schemas tenant_%_* are ambiguous between them)', r.short_id, r.long_id, r.short_id;
  END LOOP;
END $$;
