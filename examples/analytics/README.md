# Saved Analytics Examples

Define **reusable, parameterized analytics** once and run them many times with
different inputs — from the UI (Analytics → *Create analytic*, then *Saved
Analytics* → *Play*) or programmatically via the API.

An analytic captures a query (AST `config` or a `sql` string) plus declared
**variables**. The query references an input with a `{{name}}` placeholder; at
run time values are bound in — typed and injection-safe for AST, escaped
literals for SQL.

## Run

```bash
npm run infra:up && npm run start
NODE_PATH=backend/node_modules node examples/analytics/run.js
# or:  npm run examples:analytics
```

## What it shows

- Create an **AST** analytic with a typed `{{mgr}}` number variable, then trigger
  it with `mgr=1`, `mgr=2`, and the default.
- Create a **SQL** analytic with a `{{region}}` variable and trigger it.
- List saved analytics.

## API

```
POST   /api/saved-analytics            create  { name, mode:'AST'|'SQL', config|sql, variables:[{name,type,default,required}] }
GET    /api/saved-analytics            list
GET    /api/saved-analytics/:id        get
DELETE /api/saved-analytics/:id        remove
POST   /api/saved-analytics/:id/run    trigger { variables: { ... } }  → { data, rowCount, plan, boundVariables }
```

Variable types: `string | number | boolean`. In an AST config, a whole-string
`"{{name}}"` becomes the typed value (e.g. a real number), and an embedded
`"...{{name}}..."` is interpolated as text. In SQL, `{{name}}` is replaced with a
safely-escaped literal.

## UI

- **Analytics page** → *Create analytic (AST + variables)*: compose an AST config
  (or SQL), *Detect {{variables}}*, declare their types/defaults, and *Save*.
- **Saved Analytics page**: each analytic has *Play* — you're prompted for any
  variables, then results + the execution plan render inline.
