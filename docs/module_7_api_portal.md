# Module 7: Automated API & Developer Portal - Low Level Design (LLD)

## 1. Module Objective & Scope
The Automated API module instantly exposes virtualized and local data as a secure, high-performance RESTful API without requiring manual backend routing. Its scope includes configuring PostgREST, dynamic query transformation (filtering, sorting, pagination), and auto-generating OpenAPI 3.0 documentation for Developer Portal consumption.

## 2. Architecture & Component Interaction

The architecture leverages PostgREST as a reverse proxy that natively translates HTTP semantics into optimized SQL.

```mermaid
graph TD
    subgraph "Consumer Ecosystem"
        Web["Web Apps (React/Angular)"]
        Mobile["Mobile Apps"]
        B2B["B2B Integrations"]
    end

    subgraph "API Gateway Layer"
        Nginx["Nginx / Kong (Rate Limiting)"]
        PostgREST["PostgREST Engine (Haskell)"]
        OpenAPI["Auto-Generated Swagger Spec"]
    end

    subgraph "Data Fabric Hub"
        DB_Schema["tenant_xyz (Virtual Schema)"]
        RLS["Row-Level Security Filter"]
    end

    Web -- "GET /users?age=gte.18" --> Nginx
    Mobile -- "POST /orders" --> Nginx
    B2B -- "GET /" --> OpenAPI
    
    Nginx --> PostgREST
    PostgREST -- "Translates to: SELECT * FROM users WHERE age >= 18" --> DB_Schema
    DB_Schema -- "Applies Claims" --> RLS
    RLS -- "JSON Output" --> PostgREST
```

**Interaction Flow:**
1. A client application makes an HTTP REST request with query parameters for filtering/sorting.
2. The request hits the Gateway which enforces rate limits and forwards to **PostgREST**.
3. PostgREST authenticates the JWT, then translates the HTTP syntax (`?age=gte.18`) into an optimized SQL query string.
4. PostgREST executes the query against the Hub, explicitly setting the `search_path` to the tenant's schema.
5. The Hub returns the result pre-formatted as JSON natively, bypassing the need for an ORM or JSON serialization in an application layer.

## 3. Configuration & Infrastructure Design

PostgREST does not require application code; it requires environment variables and specific PostgreSQL roles.

### Docker Environment Configuration (`docker-compose.yml`)
```yaml
services:
  postgrest:
    image: postgrest/postgrest:v12.0.0
    environment:
      PGRST_DB_URI: "postgres://authenticator:super_secret_password@postgres:5432/fabric_hub"
      PGRST_DB_SCHEMA: "public" # Tenant schemas are accessed via search_path manipulation
      PGRST_DB_ANON_ROLE: "web_anon"
      PGRST_JWT_SECRET: "my_32_character_minimum_secret_key"
      PGRST_OPENAPI_SERVER_PROXY_URI: "https://api.zero-data-fabric.com"
      PGRST_OPENAPI_MODE: "follow-privileges" # Only show endpoints the user has access to
```

## 4. API Specifications (Contract)

### 4.1. Auto-Generated OpenAPI Spec
A developer can request the OpenAPI specification to generate client SDKs.

**Endpoint:** `GET /`
**Authentication:** Bearer Token (JWT).

**Success Response (200 OK):**
```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "PostgREST API",
    "version": "12.0.0"
  },
  "paths": {
    "/data_sources": {
      "get": {
        "summary": "data_sources",
        "parameters": [
          { "name": "source_type", "in": "query", "schema": { "type": "string" } }
        ]
      }
    }
  }
}
```

### 4.2. Data Operations (CRUD)
Examples of how PostgREST maps REST to SQL automatically.

*   **Read (Filter & Sort)**:
    *   `GET /users?age=gte.18&order=name.asc`
    *   *SQL*: `SELECT * FROM users WHERE age >= 18 ORDER BY name ASC`
*   **Insert (Bulk)**:
    *   `POST /events` (Payload: Array of JSON objects)
    *   *SQL*: `INSERT INTO events (col1) VALUES (val1), (val2)`
*   **Vertical Filtering (GraphQL-like)**:
    *   `GET /orders?select=id,total,users(name,email)`
    *   *SQL*: `SELECT id, total, (SELECT row_to_json(...) FROM users...) FROM orders`

## 5. Core Algorithms & Service Logic

### Algorithm: JWT Context Injection (PostgREST Internal Logic)

```text
// Pseudocode for how PostgREST handles an incoming request securely
function processRequest(httpRequest): HTTPResponse {
    token = extractBearerToken(httpRequest)
    
    if (token is None):
        return HTTP_401_UNAUTHORIZED
        
    try {
        claims = verifyJwtSignature(token, PGRST_JWT_SECRET)
        
        // Ensure the token has the required role
        if claims.role != 'web_anon':
            return HTTP_403_FORBIDDEN
            
        // Open DB connection and start transaction
        db.query("BEGIN;")
        
        // Switch to the unprivileged role
        db.query(f"SET LOCAL ROLE {claims.role};")
        
        // Inject all JWT claims into Postgres context for RLS to consume
        db.query(f"SET LOCAL request.jwt.claims = '{toJson(claims)}';")
        
        // Inject tenant schema into search path
        db.query(f"SET LOCAL search_path TO tenant_{claims.tenant_id}, public;")
        
        // Execute the actual user query
        result = db.query(translateHttpToSql(httpRequest))
        
        db.query("COMMIT;")
        return HTTP_200_OK(result)
        
    } catch (JWTExpiredException) {
        return HTTP_401_UNAUTHORIZED
    } catch (SQLException) {
        db.query("ROLLBACK;")
        return HTTP_400_BAD_REQUEST
    }
}
```

## 6. Security, Governance & Error Handling

*   **Denial of Service (DoS) Prevention**: PostgREST executes all queries with a `statement_timeout` configured in Postgres. If a user requests a massive unindexed join via the REST API, the query will be killed by the database after `N` milliseconds, preventing compute starvation.
*   **Pagination Safety**: PostgREST prevents returning millions of rows by default. The `Range` header is used by clients to request chunks (e.g., `Range: 0-49`). The server enforces a hard limit using `PGRST_MAX_ROWS=1000`.
*   **API Obfuscation (`OPENAPI_MODE`)**: By configuring `PGRST_OPENAPI_MODE="follow-privileges"`, the `/` endpoint only generates documentation for tables and columns that the specific authenticated user has `SELECT` access to. It actively hides the existence of other tables.
