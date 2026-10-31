import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { developerSpec } from './openapi/developer';
import { systemSpec } from './openapi/system';

/**
 * Mounts the interactive API documentation:
 *
 * - `GET /api-docs`                     small landing page linking to both documents
 * - `GET /api-docs.json`                302 to the developer spec (kept for old tooling)
 * - `GET /api-docs/developer`  (+ `.json`)  integrator API (auth, tokens, data, AST queries, ...)
 * - `GET /api-docs/system`     (+ `.json`)  whole-platform operator API (developer + admin, workers, plans, ...)
 *
 * All doc routes are public (no credentials); "Try it out" uses the Authorize dialog.
 */
export function mountApiDocs(app: Express): void {
  const uiOptions = (title: string) => ({
    customSiteTitle: title,
    swaggerOptions: {
      docExpansion: 'none',
      filter: true,
      tryItOutEnabled: true,
      persistAuthorization: true,
      displayRequestDuration: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const landing = (_req: Request, res: Response) => {
    res.type('html').send(LANDING_HTML);
  };

  app.get('/api-docs', landing);
  app.get('/api-docs/', landing);
  app.get('/api-docs.json', (_req, res) => res.redirect(302, '/api-docs/developer.json'));

  app.get('/api-docs/developer.json', (_req, res) => {
    res.json(developerSpec);
  });
  app.get('/api-docs/system.json', (_req, res) => {
    res.json(systemSpec);
  });

  const dev = uiOptions('Zero Data Fabric - Developer API');
  const sys = uiOptions('Zero Data Fabric - System API');
  app.use('/api-docs/developer', ...swaggerUi.serveFiles(developerSpec, dev), swaggerUi.setup(developerSpec, dev));
  app.use('/api-docs/system', ...swaggerUi.serveFiles(systemSpec, sys), swaggerUi.setup(systemSpec, sys));
}

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zero Data Fabric - API reference</title>
<style>
  :root { --bg:#f7f8fb; --card:#fff; --fg:#0f172a; --muted:#475569; --accent:#4f46e5; --border:#e2e8f0; }
  @media (prefers-color-scheme: dark) { :root { --bg:#04060f; --card:#0b1020; --fg:#e5e9f5; --muted:#94a3b8; --accent:#818cf8; --border:#1e293b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width: 880px; margin: 0 auto; padding: 48px 16px; }
  h1 { margin:0 0 8px; font-size: 1.8rem; }
  p.lead { color:var(--muted); margin:0 0 32px; }
  .grid { display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:20px; }
  .card h2 { margin:0 0 8px; font-size:1.2rem; }
  .card p { color:var(--muted); margin:0 0 16px; }
  a.btn { display:inline-block; padding:8px 14px; border-radius:8px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; margin-right:8px; }
  a.alt { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<main>
  <h1>Zero Data Fabric API</h1>
  <p class="lead">Two OpenAPI 3.0.3 documents: pick the audience that fits.</p>
  <div class="grid">
    <section class="card">
      <h2>Developer API</h2>
      <p>For integrators: login, developer API tokens, CRUD, AST queries, analytics, metadata manifests, governance and triggers.</p>
      <a class="btn" href="/api-docs/developer">Open docs</a><a class="alt" href="/api-docs/developer.json">openapi.json</a>
    </section>
    <section class="card">
      <h2>System API</h2>
      <p>For operators: everything above plus admin (tenants, connections, users, audit), Citus worker nodes, plans, settings and health.</p>
      <a class="btn" href="/api-docs/system">Open docs</a><a class="alt" href="/api-docs/system.json">openapi.json</a>
    </section>
  </div>
</main>
</body>
</html>`;
