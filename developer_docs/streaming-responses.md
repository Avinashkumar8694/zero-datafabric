# Streaming Responses (`stream: true | false`)

Query endpoints can return results **buffered** (one JSON envelope — the default) or
**streamed** as NDJSON (one row per line, delivered as they're written, plus a final
`{__meta__}` trailer). Opt in per request with `stream: true`.

Supported on: **`POST /api/analytics/query`** (AST) and **`POST /api/queries/exec`** (SQL).

Runnable demo: `NODE_PATH=backend/node_modules node examples/analytics/streaming.js`

---

## How to turn it on

`stream` may be set three equivalent ways (any truthy: `true`/`"true"`/`1`):

```jsonc
// top-level in the body
{ "stream": true, "queryConfig": { … } }        // /api/analytics/query
{ "stream": true, "sql": "SELECT …" }            // /api/queries/exec
// inside queryConfig
{ "queryConfig": { "stream": true, "type": "SELECT", … } }
// or as a query-string flag
POST /api/analytics/query?stream=true
```

Default is `stream: false` — existing callers (UI table, saved-analytics, audit modal) are unchanged.

---

## `stream: false` — buffered (default)

**Processing:** the engine plans, scans each source with pushdown, combines in-fabric,
applies HAVING/order/limit, and captures the full audit telemetry — then serializes the
**entire** result into one JSON document.

**Response:** `Content-Type: application/json`, a single envelope:
```json
{ "data": [ {…}, {…} ], "rowCount": 4,
  "plan": { "strategy": "SINGLE_CONNECTOR", "legs": [...], "pushed": [...], "executionMs": 19 },
  "warnings": [] }
```
Nothing reaches the client until the whole result is ready. Best for small/medium results,
and required when the caller needs the whole set at once (rendering a table, saving an analytic).

**Utilize:**
```bash
curl -s $BASE/api/analytics/query -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \
     -H 'Content-Type: application/json' \
     -d '{"queryConfig":{"type":"SELECT","schema":"an_lab","limit":5,
          "query":{"from":{"resource":"employees","source":"An_Lab"},"select":["id","name"],
          "where":[{"column":"dept_id","operator":"EQ","value":10}]}}}'
```

---

## `stream: true` — NDJSON stream

**Processing:** identical planning/pushdown/compensation and identical **audit capture**
(the query log still records legs/TAT/memory). The difference is delivery: rows are written
to the socket as an NDJSON stream and the plan/legs are sent **last**, as a trailer — so the
client can start working before the response finishes, hold far less in memory, and **cancel**
early (disconnecting stops the server writing).

> **Two things happen under `stream: true`** — see "Internal (cursor) streaming" below:
> 1. **Response streaming** (always): rows are delivered as NDJSON with a trailer.
> 2. **Internal cursor streaming** (when the query is a pass-through scan AND
>    `FABRIC_STREAM_INTERNAL` is on): rows are pulled from the source with a CURSOR in
>    bounded batches and never fully materialized in fabric memory — so **server memory
>    is bounded** (O(batch), not O(rows)). Blocking shapes (join / aggregate / set-op /
>    window / DISTINCT) fall back to compute-then-stream. Full node-to-node streaming of
>    blocking operators is the remaining roadmap in
>    [system_docs/18](../system_docs/18-federated-search-and-streaming.md).

**Response:** `Content-Type: application/x-ndjson` (header `X-Fabric-Stream: ndjson`),
chunked. One JSON object per line:
```
{"id":1,"name":"CEO","dept_id":10,"salary":500}
{"id":2,"name":"VP-A","dept_id":10,"salary":300}
{"id":4,"name":"Eng-1","dept_id":10,"salary":100}
{"id":5,"name":"Eng-2","dept_id":10,"salary":120}
{"__meta__":{"streamed":true,"rowCount":4,"strategy":"SINGLE_CONNECTOR","plan":{…},"warnings":[]}}
```
- **Every data row** is a plain object.
- **The final line** always has the `__meta__` key — that's the trailer with `rowCount`,
  `strategy`, the full `plan` (legs/pushdown) and `warnings`. A client detects end-of-data by
  the `__meta__` key, never by counting.

**Utilize (curl — rows appear as they arrive; `-N` disables buffering):**
```bash
curl -N -s $BASE/api/analytics/query -H "Authorization: Bearer $T" -H 'x-tenant-id: tenant_A' \
     -H 'Content-Type: application/json' \
     -d '{"stream":true,"queryConfig":{"type":"SELECT","schema":"an_lab","limit":5,
          "query":{"from":{"resource":"employees","source":"An_Lab"},"select":["id","name"]}}}'
```

**Utilize (Node — process each row incrementally, then read the trailer):**
```js
const res = await axios.post(url, { stream: true, queryConfig }, { headers, responseType: 'stream' });
const rl = require('readline').createInterface({ input: res.data });
let meta = null;
for await (const line of rl) {
  if (!line.trim()) continue;
  const obj = JSON.parse(line);
  if (obj.__meta__) meta = obj.__meta__;   // trailer (last line): plan/legs/rowCount
  else handleRow(obj);                     // a data row — render/aggregate/write incrementally
}
console.log('done:', meta.rowCount, meta.strategy);
```

**Utilize (browser — `fetch` + a streaming reader):**
```js
const resp = await fetch('/api/analytics/query', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'x-tenant-id': 'tenant_A' },
  body: JSON.stringify({ stream: true, queryConfig }),
});
const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  let nl; while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.__meta__) onDone(obj.__meta__); else appendRowToTable(obj);
  }
}
// To cancel early (e.g. user navigates away): reader.cancel()  → server stops writing.
```

---

## Internal (cursor) streaming — the server-memory win

There are **two kinds** of streaming, and `stream: true` engages both when it can:

| | Response streaming | Internal (cursor) streaming |
|---|---|---|
| What | how results reach the **client** (NDJSON) | how the engine **pulls rows** from the source (cursor, bounded batches) |
| Server memory | still holds the result | **bounded to one batch** — not materialized |
| Applies to | every `stream: true` request | **pass-through scans only** (single source; filter/projection/sort/limit; no join/aggregate/set-op/window/DISTINCT/CALL) |
| Sources | any | **all engines**: hub/remote Postgres (`pg-query-stream`), MongoDB (native cursor), Elasticsearch (scroll cursor), MySQL (`.stream()`), Snowflake (`streamResult`) |
| Header | `X-Fabric-Stream: ndjson` | `X-Fabric-Stream: ndjson-internal` |
| Strategy in trailer/audit | `…` | `RAW_SQL+STREAM` / `SINGLE_CONNECTOR+STREAM` |

A **pass-through** query streams from the source cursor; a **blocking** query (needs the whole
input — a final `ORDER BY` that isn't pushed, an aggregate, a join, a set-op, `DISTINCT`, a
window) falls back to **compute-then-stream** (computed, then delivered as NDJSON). The
`X-Fabric-Stream` header tells you which path ran.

**Measured (50,000-row hub query, `/api/queries/exec`):** the audit `memDeltaKb` was
**~6,400 KB buffered vs ~1,430 KB streamed** — and because internal streaming is O(batch),
the gap widens as the result grows. `LIMIT` early-terminates the source cursor; a client
disconnect cancels it mid-flight (freeing the connection) — neither is possible with buffering.

Demo: `NODE_PATH=backend/node_modules node examples/analytics/streaming.js` (both modes).

## Configuration

Internal streaming and the default streaming behaviour are governed by env (read per-request,
so they're runtime-tunable):

| Env | Default | Effect |
|---|---|---|
| `FABRIC_STREAM_INTERNAL` | `on` | master switch for cursor-based internal streaming of pass-through scans (off → always compute-then-stream) |
| `FABRIC_STREAM_DEFAULT` | `off` | default value of the per-request `stream` flag when the caller omits it |
| `FABRIC_STREAM_BATCH` | `500` | rows per cursor round-trip (Postgres `FETCH` size / Mongo `batchSize`) |
| `FABRIC_STREAM_HIGHWATER` | `1000` | backpressure high-water mark for the cursor→NDJSON pipe |

The per-request `stream` flag always wins over `FABRIC_STREAM_DEFAULT`.

## When to use which

| | `stream: false` | `stream: true` |
|---|---|---|
| Response | one JSON envelope | NDJSON rows + `__meta__` trailer |
| Client sees first row | after full result | as soon as the first row is written |
| Client memory | holds whole result | can process + discard row-by-row |
| Early cancel | no | yes (disconnect stops the server) |
| Best for | UI tables, saved analytics, small/medium results, needing `plan` up-front | large result sets, progressive rendering, export/ETL, pipe-to-file |
| Audit log | captured | captured (identical) |

**Honest caveat:** a query whose top operator is *blocking* (a final `ORDER BY`, a top-level
aggregate, `DISTINCT`) still can't emit its first row until that operator finishes — streaming
helps delivery and client memory/cancel, not that barrier. See system_docs/18 for the
node-to-node streaming roadmap that addresses the compute side.
