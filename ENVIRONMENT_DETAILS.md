# Environment Details — Zero Data Fabric

## 1. Deployment Architecture

The platform is split into two docker-compose configurations:

| Stack | File | Purpose | Network |
|-------|------|---------|---------|
| **Development** | `developer_docker_compose/docker-compose.yml` | Local dev, hot reload, exposed ports | `dev-network` (bridge) |
| **Production** | `docker/docker-compose.yml` | Pre-built images, Traefik TLS, no exposed ports | `datafabric_network` + `traefik_network` |

---

## 2. Docker Images

### Backend (`backend/Dockerfile`)

```dockerfile
FROM node:20-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --legacy-peer-deps
COPY backend/ ./
EXPOSE 4000
CMD ["npm", "start"]
```

**Key points:**
- Base image: `node:20-alpine`
- Build context: project root (`docker/docker-compose.yml` sets `context: ../`)
- `COPY backend/ ./` includes the entire backend directory **and** the `developer_docs/` folder (at `../../developer_docs` relative to backend src) because the Docker build context is the project root
- The `developer_docs` folder is needed at runtime for the new `/api/developer-docs` endpoints
- Exposed port: **4000**
- Entry command: `npm start` (runs `node dist/index.js` via ts-node or compiled output)

### UI (`ui/Dockerfile`)

```dockerfile
FROM node:20-alpine
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
EXPOSE 3001
CMD ["npm", "start"]
```

**Key points:**
- Base image: `node:20-alpine`
- Build context: project root
- Does NOT include `developer_docs/` — docs are served via backend API
- Exposed port: **3001**
- Entry command: `npm start` (runs `ts-node src/index.ts`)

---

## 3. Environment Variables

### Backend (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | API listen port |
| `DATABASE_URL` | `postgresql://fabric_admin:fabric_password@localhost:5434/datafabric` | Postgres connection |
| `JWT_SECRET` | `reallyreallyreallyreallyverysecret` | JWT signing key |
| `OIDC_ISSUER` | `http://localhost:3000` | SSO provider URL |
| `OIDC_CLIENT_ID` | `zero-datafabric` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | `super-secret-key-fabric` | OIDC client secret |
| `OIDC_CALLBACK_URL` | `http://localhost:4000/api/auth/sso/callback` | SSO callback |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `KAFKA_BROKERS` | `localhost:9092` | Kafka broker list |
| `REPLICATION_ENGINE_EXTERNAL` | `false` | Run replication as separate microservice |
| `FABRIC_CDC_VIA_KAFKA` | `false` | Enable Kafka CDC pipeline |

### Backend (docker-compose overrides)

**Production (`docker/docker-compose.yml`):**
```yaml
environment:
  PORT: "4000"
  DB_HOST: db                    # Docker service name
  DB_PORT: "5432"
  DB_USERNAME: ${DB_USERNAME:-fabric_admin}
  DB_PASSWORD: ${DB_PASSWORD:-fabric_password}
  DB_DATABASE: ${DB_NAME:-datafabric}
  REDIS_HOST: redis
  REDIS_PORT: "6379"
  KAFKA_BROKERS: "kafka:29092"
  REPLICATION_ENGINE_EXTERNAL: "true"
```

**Development (`developer_docker_compose/docker-compose.yml`):**
```yaml
environment:
  NODE_ENV: development
  PORT: "4000"
  DB_HOST: db
  DB_PORT: "5432"
  DB_USERNAME: fabric_admin
  DB_PASSWORD: fabric_password
  DB_DATABASE: datafabric
  REDIS_HOST: redis
  REDIS_PORT: "6379"
  KAFKA_BROKERS: "kafka:29092"
  REPLICATION_ENGINE_EXTERNAL: "true"
```

### UI (docker-compose)

```yaml
environment:
  PORT: "3001"
  BACKEND_URL: http://backend:4000   # Internal Docker DNS
```

---

## 4. Routing & Networking

### Development
- UI: `http://localhost:3001` → directly exposed
- Backend: `http://localhost:4000` → directly exposed
- UI calls backend via `BACKEND_URL: http://backend:4000` (internal Docker DNS)

### Production (Traefik)
- Domain: `fabric.fabrixly.com`
- **Backend API**: `https://fabric.fabrixly.com/api/*` → Traefik routes to backend:4000
- **UI**: `https://fabric.fabrixly.com/*` → Traefik routes to ui:3001
- **PostgREST**: `https://fabric.fabrixly.com/postgrest/*` → port 3005

Traefik labels on backend:
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.datafabric-backend.rule=Host(`fabric.fabrixly.com`) && PathPrefix(`/api`)"
  - "traefik.http.routers.datafabric-backend.tls=true"
  - "traefik.http.routers.datafabric-backend.tls.certresolver=letsencrypt"
  - "traefik.http.services.datafabric-backend.loadbalancer.server.port=4000"
```

Traefik labels on UI:
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.datafabric-ui.rule=Host(`fabric.fabrixly.com`)"
  - "traefik.http.routers.datafabric-ui.tls=true"
  - "traefik.http.routers.datafabric-ui.tls.certresolver=letsencrypt"
  - "traefik.http.services.datafabric-ui.loadbalancer.server.port=3001"
```

---

## 5. Data Infrastructure Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `db` | `citusdata/citus:latest` | 5434 (dev) | Master coordinator Postgres/Citus |
| `redis` | `redis:7-alpine` | 6379 | Query cache, rate limiting, event queues |
| `postgrest` | `postgrest/postgrest:v12.0.0` | 3005 | Instant Data API |
| `kafka` + `zookeeper` | `confluentinc/cp-kafka:7.4.0` | 9092 | CDC streaming |
| `remote_db` | `postgres:15-alpine` | 5436 | Remote datasource for virtualization testing |
| `mongodb` | `mongo:6.0` | 27017 | NoSQL datasource |
| `mysql` | `mysql:8.0` | 3307 | MySQL datasource |
| `oracle` | `gvenzl/oracle-free:23-slim` | 1521 | Oracle datasource |
| `elasticsearch` | `elasticsearch:8.13.4` | 9200 | Search engine / downstream |
| `kibana` | `kibana:8.13.4` | 5601 | ES visualization |

---

## 6. Integration Guide API Contract

### Backend Endpoints (new)

```
GET /api/developer-docs
```
Returns the grouped doc list:
```json
{
  "groups": [
    {
      "label": "Getting Started",
      "docs": [{ "id": "how-to-guide.md", "title": "How-To Developer Guide" }]
    }
  ]
}
```

```
GET /api/developer-docs/:id
```
Returns a single document:
```json
{
  "id": "how-to-guide.md",
  "title": "How-To Developer Guide",
  "group": "Getting Started",
  "htmlContent": "<h1>...</h1>"
}
```

### UI Consumption

The UI's `integration_guide.ejs` loads docs dynamically via:
```javascript
const DOCS_API = API_BASE + '/api/developer-docs';
// DOCS_API resolves to:
// - Dev:  http://localhost:4000/api/developer-docs
// - Prod: https://fabric.fabrixly.com/api/developer-docs
```

The existing `API_BASE` logic in `header.ejs` handles this:
```javascript
const API_BASE = window.location.hostname.includes('fabrixly.com')
    ? `/api`
    : `http://${window.location.hostname}:4000/api`;
```

---

## 7. File Layout in Docker

### Backend Container (`/app/backend/`)
```
/app/backend/
├── dist/                    # Compiled JS
├── node_modules/
├── developer_docs/          # ⚠️ MUST be present — copied via COPY backend/ ./
│   ├── how-to-guide.md
│   └── ...
├── src/
│   ├── index.ts             # Entry point
│   ├── controllers/
│   │   └── developerDocsController.ts
│   └── routes/
│       └── developerDocsRoutes.ts
└── package.json
```

**Important:** The `developer_docs/` folder lives at the **project root** (`/Users/avinashkumargupta/Documents/projects/Zero/zero-datafabric/developer_docs`). Since the Docker build context is the project root and the Dockerfile does `COPY backend/ ./`, the `developer_docs` folder is **NOT** automatically included.

**Fix required:** Either:
1. Add `COPY ../developer_docs ./developer_docs` to the backend Dockerfile, OR
2. Add the docs to the `.dockerignore` exception list

### UI Container (`/app/ui/`)
```
/app/ui/
├── node_modules/
├── src/
│   ├── index.ts
│   └── views/
│       ├── integration_guide.ejs
│       └── partials/
└── package.json
```

No `developer_docs` needed in the UI container.

---

## 8. Build & Deploy Commands

### Development
```bash
# Start everything with local builds
cd developer_docker_compose
docker-compose up --build

# Or from project root using the dev compose
docker-compose -f developer_docker_compose/docker-compose.yml up --build
```

### Production
```bash
# Build and push images first
docker build -t kumaravinit/zero:datafabric-backend-1.0.0 ./backend
docker build -t kumaravinit/zero:datafabric-ui-1.0.0 ./ui
docker push kumaravinit/zero:datafabric-backend-1.0.0
docker push kumaravinit/zero:datafabric-ui-1.0.0

# Deploy
cd docker
docker-compose up -d
```

---

## 9. Networking Topology

```
                    ┌─────────────────────────────────────┐
                    │         Traefik (Reverse Proxy)       │
                    │   fabric.fabrixly.com (TLS/HTTPS)    │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────┴──────────────────────┐
                    │                                     │
              ┌─────▼─────┐                       ┌────────▼──────┐
              │   UI      │                       │   Backend     │
              │ :3001     │                       │   :4000       │
              │           │                       │               │
              │ Serves    │                       │ REST API      │
              │ docs via  │──────────────────────>│ /api/         │
              │ fetch()   │   http://backend:4000  │ developer-docs│
              └───────────┘                       └───────────────┘
                    │                                     │
                    │         ┌───────────────────────────┘
                    │         │
              ┌─────▼─────┐   │
              │  Browser   │◄──┘  User hits /integration-guide
              │  (client)  │      UI fetches docs from backend
              └───────────┘
```

---

## 10. Critical Gotchas

1. **`developer_docs` must be in the backend Docker image** — currently the `COPY backend/ ./` in the Dockerfile does NOT include the project-root `developer_docs/` folder. This must be fixed for production.

2. **`__dirname` in compiled JS** — the controller uses `path.join(__dirname, '..', '..', '..', 'developer_docs')`. After TypeScript compilation, `__dirname` points to `dist/controllers/`, so `../../..` resolves to the project root correctly. This works as long as the folder structure is preserved in the Docker image.

3. **UI's `BACKEND_URL`** is only used in the EJS templates' inline JS for `API_BASE` fallback. The production logic (`hostname.includes('fabrixly.com') ? '/api' : ...`) means the UI correctly proxies through Traefik in production.

4. **Authentication on docs API** — the `/api/developer-docs` endpoints are currently **unauthenticated** (no `requireAuth` middleware). This matches the existing `/api/health` pattern. If docs should be restricted to logged-in users, add `requireAuth` to the routes.

5. **CORS** — backend has `origin: '*'` CORS, so the UI can fetch docs from any origin.
