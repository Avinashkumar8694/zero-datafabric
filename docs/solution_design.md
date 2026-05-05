# Zero Data Fabric - Solution Design Document

## 1. Introduction
This document outlines the modular architecture and design for the Zero Data Fabric, an enterprise-level data integration and virtualization platform built on PostgreSQL.

## 2. System Architecture
The system follows a hub-and-spoke model where PostgreSQL acts as the central hub, integrating various SQL and NoSQL sources.

```mermaid
graph TD
    subgraph "Frontend Layer"
        EJS_UI["EJS Dashboard UI (Node.js)"]
    end

    subgraph "API & Orchestration Layer"
        ExpressApp["Node.js Express Orchestrator (TS)"]
        PostgREST["PostgREST (Data API)"]
    end

    subgraph "Data Fabric Hub (PostgreSQL)"
        direction TB
        PGCore["PostgreSQL Core Engine"]
        subgraph "Extensions"
            FDW["Foreign Data Wrappers (SQL/NoSQL)"]
            Citus["Citus (Sharding/Scale)"]
            PGVector["PGVector (AI/Vector Search)"]
            PGAudit["PGAudit (Compliance)"]
        end
        Catalog["Metadata & Lineage Catalog"]
    end

    subgraph "Data Integration Layer"
        Debezium["Debezium (CDC)"]
        Kafka["Apache Kafka (Event Bus)"]
    end

    subgraph "Data Sources (Spokes)"
        RDS["Remote SQL (Postgres/MySQL/Oracle)"]
        NoSQL["NoSQL (MongoDB/Redis)"]
        APIs["External APIs"]
    end

    EJS_UI <--> ExpressApp
    EJS_UI <--> PostgREST
    ExpressApp <--> PGCore
    PostgREST <--> PGCore
    
    FDW <--> RDS
    FDW <--> NoSQL
    FDW <--> APIs
    
    RDS -- CDC --> Debezium
    NoSQL -- CDC --> Debezium
    Debezium --> Kafka
    Kafka --> PGCore
```

## 3. Modular Breakdown

### Module 1: Core Infrastructure & Multi-Tenancy
*   **Responsibility**: Database provisioning, PostgREST setup, and logical isolation.
*   **Mechanism**: Schema-per-tenant isolation using PostgreSQL schemas. JWT-based authentication where PostgREST enforces Row-Level Security (RLS) using claims.

### Module 2: Data Virtualization (FDW Hub)
*   **Responsibility**: Real-time querying of external sources without data movement.
*   **Mechanism**: Dynamic provisioning of `postgres_fdw`, `mysql_fdw`, and `mongo_fdw` via secure PL/pgSQL functions.

### Module 3: Real-Time Data Sync (CDC)
*   **Responsibility**: Change Data Capture for high-performance syncing.
*   **Mechanism**: Debezium monitoring source logs (WAL/Oplog) and streaming events into Kafka, which are then ingested into the Fabric.

### Module 4: Active Metadata & Lineage
*   **Responsibility**: Tracking data context, ownership, and movement.
*   **Mechanism**: A central JSONB-based catalog storing schema information and a lineage graph showing data origin (Source -> FDW -> View).

### Module 5: Event-Driven Architecture
*   **Responsibility**: Real-time notifications on data changes.
*   **Mechanism**: PostgreSQL `LISTEN/NOTIFY` triggers sent to the Express App, which pushes to the EJS UI via WebSockets or executes external Webhooks.

### Module 6: Advanced Analytics & AI
*   **Responsibility**: Distributed scaling and vector search.
*   **Mechanism**: Citus for sharding massive tables and `pgvector` for storing LLM embeddings for semantic search.

## 4. Key Workflows

### 4.1. Data Virtualization Flow
```mermaid
sequenceDiagram
    participant User
    participant UI as Angular UI
    participant Exp as Express Orchestrator
    participant DB as Postgres (Hub)
    participant Rem as Remote Source

    User->>UI: Connect New Source (e.g. MySQL)
    UI->>Exp: POST /api/admin/create-connection
    Exp->>DB: CALL admin_functions.register_remote_source(...)
    DB->>DB: CREATE FOREIGN SERVER & USER MAPPING
    DB->>DB: IMPORT FOREIGN SCHEMA
    Exp-->>UI: Connection Successful
    User->>UI: Run Query
    UI->>DB: SELECT * FROM virtual_table (via PostgREST)
    DB->>Rem: Query Pushdown (WHERE filters)
    Rem-->>DB: Filtered Results
    DB-->>UI: Combined Data
```

### 4.2. CDC Sync Flow
```mermaid
sequenceDiagram
    participant Rem as Remote Source
    participant Deb as Debezium
    participant Kaf as Kafka
    participant DB as Postgres (Hub)
    participant UI as Angular UI

    Rem->>Rem: Data Changed (INSERT/UPDATE)
    Deb->>Rem: Read WAL / Oplog
    Deb->>Kaf: Produce Event
    Kaf->>DB: Consume & Ingest into Hub
    DB->>DB: Trigger NOTIFY
    DB->>UI: WebSocket Update (Real-time)
```

## 5. Security Model
*   **Zero-Trust**: Every request must carry a valid JWT.
*   **RLS**: Row-Level Security policies in PostgreSQL use `current_setting('request.jwt.claims')::json->>'tenant_id'` to ensure data isolation at the engine level.
*   **Audit**: `pgaudit` captures every DDL and DML operation for compliance.
