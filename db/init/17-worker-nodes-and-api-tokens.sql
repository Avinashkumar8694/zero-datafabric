-- Distributed execution: Citus worker-node registry + developer API tokens.

CREATE TABLE IF NOT EXISTS public.fabric_worker_nodes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              VARCHAR(63)  NOT NULL,
    host              VARCHAR(253) NOT NULL,
    port              INTEGER      NOT NULL CHECK (port BETWEEN 1 AND 65535),
    status            VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','INACTIVE','DRAINING','DOWN','DRIFT','FAILED')),
    should_have_shards BOOLEAN     NOT NULL DEFAULT TRUE,
    labels            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    citus_node_id     INTEGER,
    last_health_status VARCHAR(8),
    last_health_latency_ms INTEGER,
    last_health_at    TIMESTAMPTZ,
    last_error        TEXT,
    created_by        VARCHAR(255),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_worker_name UNIQUE (name),
    CONSTRAINT uq_worker_endpoint UNIQUE (host, port)
);

CREATE TABLE IF NOT EXISTS public.fabric_worker_events (
    id         BIGSERIAL PRIMARY KEY,
    worker_id  UUID,
    action     VARCHAR(40) NOT NULL,
    actor      VARCHAR(255),
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_worker_events_created ON public.fabric_worker_events (created_at DESC);

CREATE TABLE IF NOT EXISTS public.api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    VARCHAR(255),
    user_id      VARCHAR(255),
    username     VARCHAR(255) NOT NULL,
    name         VARCHAR(100) NOT NULL,
    prefix       VARCHAR(16)  NOT NULL UNIQUE,
    token_hash   CHAR(64)     NOT NULL,
    scopes       TEXT[]       NOT NULL DEFAULT '{}',
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_owner ON public.api_tokens (user_id, tenant_id);
