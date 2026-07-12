# Running the tests

The suite has two tiers. **Unit tests** are pure and need no services — run these
by default. **Integration tests** drive the live stack and need Docker infra +
seed data + fixtures.

## Unit tests (fast, no dependencies) — the default

```bash
npm test              # → cd backend && npm run test:unit
# or directly:
cd backend && npm run test:unit
```

Runs every `src/modules/**/*.test.ts` (pushdown, aggregate, federation,
sql_translator, compensate, policy, constraint, grant, analytics, …). **All pass
with no database** — this is the command to use for a quick, reliable check.

## Integration tests (need the full stack)

```bash
npm run infra:up          # Docker: Postgres hub/remote, Mongo, ES, Redis
npm run db:migrate        # schema
cd backend && npm run db:seed   # admin + base data
npm run test:integration  # → jest src/tests --runInBand
```

These `src/tests/apis/*` suites exercise real HTTP + real engines. Some require
specific seed/template fixtures and are environment-sensitive; expect a subset to
fail unless the fixtures they assume are present. They are **not** part of
`npm test` for that reason.

## Everything

```bash
npm run test:all          # unit + integration, in band
```

## Why `npm test` was failing before

`npm test` used to run the **entire** suite (unit + integration). Without the
Docker stack + seed data the integration suites fail, which looked like "the
tests don't run". `npm test` now runs the **unit** tier only (reliable
everywhere); use `test:integration` / `test:all` when the stack is up.

## Scripts

| Command | Runs |
|---|---|
| `npm test` / `npm run test:unit` | unit tests (`backend/src/modules`) — no DB |
| `npm run test:integration` | API/integration tests (`backend/src/tests`) — needs infra + seed |
| `npm run test:all` | both tiers |
| `npm run docs:generate` | JSDoc → docdash HTML in `docs/api-html/` |
