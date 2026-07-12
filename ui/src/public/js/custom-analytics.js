/* Custom Analytics — interactive AST builder, list, play. Uses globals from the
   header partial: API_BASE, getAuthHeaders(), escapeHtml(), showModal(). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const val = (id) => { const e = $(id); return e ? e.value : ''; };
  const TYPES = ['SELECT', 'AGGREGATE', 'RECURSIVE', 'CALL'];
  let SOURCES = [];
  let COLS = [];            // columns of the selected resource
  let JOINCOLS = [];        // columns of the join resource
  let RESMAP = {};          // sourceName -> { resource -> schemaPhysical }
  let state = { type: 'SELECT', cols: new Set(), groupBy: new Set(), raw: false, preview: 'AST', ctes: [] };

  async function getJson(path) { const r = await fetch(`${API_BASE}${path}`, { headers: getAuthHeaders() }); return r.json(); }
  async function post(path, body) { const r = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify(body) }); return { ok: r.ok, data: await r.json() }; }

  // ---------- sources / resources / columns ----------
  async function loadSources() {
    SOURCES = await getJson('/metadata/sources') || [];
    const opts = SOURCES.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} (${escapeHtml(s.type)})</option>`).join('');
    $('bSource').innerHTML = opts;
    await onBSource();
  }
  function sourceOptions(sel) { return SOURCES.map((s) => `<option value="${escapeHtml(s.name)}" ${s.name === sel ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join(''); }
  async function resourcesFor(sourceName) {
    const src = SOURCES.find((s) => s.name === sourceName);
    if (!src) return [];
    RESMAP[sourceName] = RESMAP[sourceName] || {};
    const schemas = await getJson(`/metadata/schemas?sourceId=${encodeURIComponent(src.id)}`);
    const out = [];
    for (const sc of (Array.isArray(schemas) ? schemas : [])) {
      const tables = await getJson(`/metadata/tables?schemaId=${encodeURIComponent(sc.schemaId || sc.id)}`);
      for (const t of (Array.isArray(tables) ? tables : [])) {
        const rt = t.resourceType || t.resource_type || 'TABLE';
        if (['TABLE', 'VIEW', 'MATERIALIZED_VIEW', 'FOREIGN_TABLE'].includes(rt)) {
          out.push(t.name); RESMAP[sourceName][t.name] = sc.physical_name || sc.physicalName || sc.name || 'public';
        }
      }
    }
    return [...new Set(out)];
  }
  async function columnsFor(source, resource) {
    try {
      const cols = await getJson(`/metadata/columns?source=${encodeURIComponent(source)}&resource=${encodeURIComponent(resource)}`);
      const list = Array.isArray(cols) ? cols : (cols.columns || cols.data || []);
      return list.map((c) => c.name || c.column_name || c).filter(Boolean);
    } catch (e) { return []; }
  }
  window.onBSource = async function () {
    const res = await resourcesFor(val('bSource'));
    const base = res.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('') || '<option value="">(none)</option>';
    const cteOpts = state.ctes.map((c) => `<option value="${escapeHtml(c.name)}">(cte) ${escapeHtml(c.name)}</option>`).join('');
    $('bResource').innerHTML = base + cteOpts;
    await onBResource();
  };
  window.onBResource = async function () {
    COLS = await columnsFor(val('bSource'), val('bResource'));
    state.cols = new Set(); state.groupBy = new Set();
    renderColChips(); renderGroupByChips(); fillColSelects(); renderPreview();
  };

  function colOptions(cols, selected) { return cols.map((c) => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`).join(''); }
  function fillColSelects() {
    // recursive selects + any new where/order rows draw from COLS
    ['bRecParent', 'bRecChild', 'bRecAnchor', 'bRecPath'].forEach((id) => { const e = $(id); if (e) e.innerHTML = (id === 'bRecPath' ? '<option value="">(none)</option>' : '') + colOptions(COLS); });
    document.querySelectorAll('.w-col, .o-col, .g-col, .agg-col').forEach((sel) => { const cur = sel.value; sel.innerHTML = (sel.classList.contains('agg-col') ? '<option value="*">*</option>' : '') + colOptions(COLS); sel.value = cur; });
  }

  // ---------- column chips ----------
  function renderColChips() {
    $('bCols').innerHTML = COLS.map((c) => `<span class="ca-chip" data-c="${escapeHtml(c)}" style="${state.cols.has(c) ? 'background:var(--primary);color:#fff;' : ''}" onclick="toggleCol('${escapeHtml(c)}')">${escapeHtml(c)}</span>`).join('') || '<span class="text-muted" style="font-size:.75rem;">no columns discovered — will use *</span>';
  }
  window.toggleCol = function (c) { if (state.cols.has(c)) state.cols.delete(c); else state.cols.add(c); renderColChips(); renderPreview(); };
  function renderGroupByChips() {
    $('bGroupBy').innerHTML = COLS.map((c) => `<span class="ca-chip" style="${state.groupBy.has(c) ? 'background:var(--primary);color:#fff;' : ''}" onclick="toggleGroup('${escapeHtml(c)}')">${escapeHtml(c)}</span>`).join('') || '<span class="text-muted" style="font-size:.75rem;">no columns discovered</span>';
  }
  window.toggleGroup = function (c) { if (state.groupBy.has(c)) state.groupBy.delete(c); else state.groupBy.add(c); renderGroupByChips(); renderPreview(); };

  // ---------- dynamic rows ----------
  const OPS = ['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN', 'LIKE', 'IS_NULL', 'IS_NOT_NULL'];
  window.addWhere = function (w) {
    w = w || {}; const div = document.createElement('div'); div.className = 'ca-row ca-where';
    div.innerHTML =
      `<select class="ca-select w-col">${colOptions(COLS, w.column)}</select>` +
      `<select class="ca-select w-op">${OPS.map((o) => `<option ${o === w.operator ? 'selected' : ''}>${o}</option>`).join('')}</select>` +
      `<input class="ca-input w-val" placeholder="value" value="${escapeHtml(w.value ?? '')}">` +
      `<label style="font-size:.7rem; white-space:nowrap;"><input type="checkbox" class="w-bind" ${w.bind ? 'checked' : ''}> bind</label>` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bWhere').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  window.addAgg = function (a) {
    a = a || {}; const div = document.createElement('div'); div.className = 'ca-row ca-agg';
    div.innerHTML =
      `<select class="ca-select agg-fn">${['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].map((f) => `<option ${f === a.aggregate ? 'selected' : ''}>${f}</option>`).join('')}</select>` +
      `<select class="ca-select agg-col"><option value="*">*</option>${colOptions(COLS, a.column)}</select>` +
      `<input class="ca-input agg-alias" placeholder="alias" value="${escapeHtml(a.alias ?? 'value')}">` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bAggs').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  window.addOrder = function (o) {
    o = o || {}; const div = document.createElement('div'); div.className = 'ca-row ca-order';
    div.innerHTML =
      `<select class="ca-select o-col">${colOptions(COLS, o.column)}</select>` +
      `<select class="ca-select o-dir"><option ${o.direction === 'DESC' ? 'selected' : ''}>DESC</option><option ${o.direction !== 'DESC' ? 'selected' : ''}>ASC</option></select>` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bOrders').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  window.addArg = function () {
    const div = document.createElement('div'); div.className = 'ca-row'; div.style.gridTemplateColumns = '1fr auto auto';
    div.innerHTML = `<input class="ca-input arg-val" placeholder="value or {{var}}"><label style="font-size:.7rem;"><input type="checkbox" class="arg-bind"> bind</label><button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bArgs').appendChild(div); div.querySelectorAll('input').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  // ---------- sub-analytics as CTEs ----------
  function cteName(n) { return String(n).replace(/[^a-zA-Z0-9_]/g, '_'); }
  function refreshCtePicker() {
    const pick = $('bCtePick'); if (!pick) return;
    const candidates = (ANALYTICS || []).filter((a) => a.mode === 'AST' && a.definition && a.definition.config && a.definition.config.query);
    pick.innerHTML = candidates.length ? candidates.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('') : '<option value="">(no AST analytics)</option>';
  }
  window.addCteFromPick = function () {
    const id = $('bCtePick').value; if (!id) return;
    const a = (ANALYTICS || []).find((x) => x.id === id); if (!a) return;
    const name = cteName(a.name);
    if (state.ctes.some((c) => c.name === name)) return; // already added
    state.ctes.push({ name, base: a.definition.config.query });
    renderCtes(); onBSource(); // rebuild resource dropdown to include the CTE
    renderPreview();
  };
  function renderCtes() {
    $('bCtes').innerHTML = state.ctes.map((c, i) =>
      `<span class="ca-chip" title="CTE from a saved analytic">${escapeHtml(c.name)} <span onclick="removeCte(${i})" style="cursor:pointer; font-weight:700;">✕</span></span>`).join('')
      || '<span class="text-muted" style="font-size:.72rem;">none — pick a saved analytic above</span>';
  }
  window.removeCte = function (i) { state.ctes.splice(i, 1); renderCtes(); onBSource(); renderPreview(); };

  const JOIN_ALIASES = ['b', 'c', 'd', 'e', 'f'];
  function reindexJoinAliases() {
    [...document.querySelectorAll('#bJoins .ca-row')].forEach((r, i) => { const b = r.querySelector('.j-alias'); if (b) b.textContent = JOIN_ALIASES[i] || `j${i}`; });
  }
  window.addJoin = function (j) {
    j = j || {}; const div = document.createElement('div'); div.className = 'ca-row'; div.style.gridTemplateColumns = 'auto .8fr 1fr 1fr auto 1fr auto'; div.style.alignItems = 'center';
    div.innerHTML =
      `<span class="j-alias" style="font-weight:700; opacity:.6;"></span>` +
      `<select class="ca-select j-type"><option ${j.type === 'LEFT' ? 'selected' : ''}>INNER</option><option ${j.type === 'LEFT' ? 'selected' : ''}>LEFT</option></select>` +
      `<select class="ca-select j-src">${sourceOptions(j.source)}</select>` +
      `<input class="ca-input j-res" placeholder="resource" value="${escapeHtml(j.resource || '')}">` +
      `<input class="ca-input j-left" placeholder="a.id" value="${escapeHtml(j.left || '')}">` +
      `<select class="ca-select j-op"><option>EQ</option></select>` +
      `<input class="ca-input j-right" placeholder="b.fk" value="${escapeHtml(j.right || '')}">` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); reindexJoinAliases(); renderPreview();">✕</button>`;
    // fix join type default
    if (j.type) div.querySelector('.j-type').value = j.type;
    $('bJoins').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); reindexJoinAliases(); renderPreview();
  };
  window.reindexJoinAliases = reindexJoinAliases;
  window.addSetOp = function (s) {
    s = s || {}; const div = document.createElement('div'); div.className = 'ca-row'; div.style.gridTemplateColumns = 'auto 1fr 1fr 1.4fr auto';
    div.innerHTML =
      `<select class="ca-select so-op">${['UNION', 'INTERSECT', 'EXCEPT'].map((o) => `<option ${o === s.op ? 'selected' : ''}>${o}</option>`).join('')}</select>` +
      `<select class="ca-select so-src">${sourceOptions(s.source)}</select>` +
      `<input class="ca-input so-res" placeholder="resource" value="${escapeHtml(s.resource || '')}">` +
      `<input class="ca-input so-cols" placeholder="col1,col2 (or *)" value="${escapeHtml((s.select || []).join(',') || '')}">` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bSetOps').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  window.addHaving = function (h) {
    h = h || {}; const div = document.createElement('div'); div.className = 'ca-row'; div.style.gridTemplateColumns = '1fr .9fr 1fr auto';
    div.innerHTML =
      `<input class="ca-input hv-col" placeholder="alias (e.g. value)" value="${escapeHtml(h.column || '')}">` +
      `<select class="ca-select hv-op">${['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'].map((o) => `<option ${o === h.operator ? 'selected' : ''}>${o}</option>`).join('')}</select>` +
      `<input class="ca-input hv-val" placeholder="value" value="${escapeHtml(h.value ?? '')}">` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bHaving').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  const WIN_FNS = ['RANK', 'DENSE_RANK', 'ROW_NUMBER', 'SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];
  window.addWindow = function (w) {
    w = w || {}; const div = document.createElement('div'); div.className = 'ca-row'; div.style.gridTemplateColumns = '1fr 1fr 1.2fr 1.2fr 1fr auto'; div.style.marginBottom = '.4rem';
    const ob = (w.orderBy && w.orderBy[0]) || {};
    div.innerHTML =
      `<select class="ca-select win-fn">${WIN_FNS.map((f) => `<option ${f === w.window ? 'selected' : ''}>${f}</option>`).join('')}</select>` +
      `<select class="ca-select win-col"><option value="">(col)</option>${colOptions(COLS, w.column)}</select>` +
      `<select class="ca-select win-part" multiple size="1" title="PARTITION BY">${colOptions(COLS)}</select>` +
      `<select class="ca-select win-ord">${colOptions(COLS, ob.column)}</select>` +
      `<div style="display:flex; gap:.2rem;"><select class="ca-select win-dir"><option ${ob.direction === 'DESC' ? 'selected' : ''}>DESC</option><option ${ob.direction !== 'DESC' ? 'selected' : ''}>ASC</option></select><input class="ca-input win-alias" placeholder="alias" value="${escapeHtml(w.alias || 'rnk')}" style="width:70px;"></div>` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bWindows').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };
  window.addVar = function (v) {
    v = v || {}; const div = document.createElement('div'); div.className = 'ca-row ca-var';
    div.innerHTML =
      `<input class="ca-input v-name" placeholder="name" value="${escapeHtml(v.name ?? '')}">` +
      `<select class="ca-select v-type">${['string', 'number', 'boolean'].map((t) => `<option ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}</select>` +
      `<input class="ca-input v-def" placeholder="default" value="${escapeHtml(v.default ?? '')}">` +
      `<label style="font-size:.7rem;"><input type="checkbox" class="v-req" ${v.required ? 'checked' : ''}> req</label>` +
      `<button class="btn-outline mini-btn" onclick="this.closest('.ca-row').remove(); renderPreview();">✕</button>`;
    $('bVars').appendChild(div); div.querySelectorAll('input,select').forEach((e) => e.addEventListener('input', renderPreview)); renderPreview();
  };

  // ---------- type tabs ----------
  function setType(t) {
    state.type = t;
    document.querySelectorAll('#bTypes .ca-type').forEach((el) => el.classList.toggle('active', el.dataset.t === t));
    document.querySelectorAll('.ca-sec[data-for]').forEach((sec) => { sec.style.display = sec.dataset.for.split(',').includes(t) ? '' : 'none'; });
    $('bSourceRow').style.display = (t === 'CALL') ? 'none' : '';
    renderPreview();
  }

  // ---------- collect + build ----------
  // Filter inputs are free text, but type-strict engines (MongoDB/Elasticsearch)
  // compare by BSON/JSON type — a numeric column filtered by the string "120" never
  // matches. Coerce a purely-numeric / boolean / null literal to its real type so the
  // same filter works on every engine. Anything else (dates, mixed strings) stays text.
  function coerceVal(raw) {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    if (s === '') return raw;
    if (/^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))) return Number(s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    return raw;
  }
  function whereRows() {
    return [...document.querySelectorAll('#bWhere .ca-row')].map((r) => {
      const column = r.querySelector('.w-col').value; const operator = r.querySelector('.w-op').value;
      const bind = r.querySelector('.w-bind').checked; let value = r.querySelector('.w-val').value;
      if (['IS_NULL', 'IS_NOT_NULL'].includes(operator)) return { column, operator };
      if (bind) value = `{{${column}}}`;
      else if (operator === 'IN') value = value.split(',').map((s) => coerceVal(s.trim()));
      else value = coerceVal(value);
      return { column, operator, value };
    });
  }
  function orderRows() { return [...document.querySelectorAll('#bOrders .ca-row')].map((r) => ({ column: r.querySelector('.o-col').value, direction: r.querySelector('.o-dir').value })); }
  function joinRows() {
    return [...document.querySelectorAll('#bJoins .ca-row')].map((r, i) => ({
      type: r.querySelector('.j-type').value, source: r.querySelector('.j-src').value,
      resource: r.querySelector('.j-res').value, alias: JOIN_ALIASES[i] || `j${i}`,
      on: { left: r.querySelector('.j-left').value || 'a.id', operator: r.querySelector('.j-op').value, right: r.querySelector('.j-right').value || `${JOIN_ALIASES[i] || 'b'}.id` },
    })).filter((j) => j.resource);
  }
  function setOpRows() {
    const out = { union: [], intersect: [], except: [] };
    for (const r of document.querySelectorAll('#bSetOps .ca-row')) {
      const op = r.querySelector('.so-op').value.toLowerCase();
      const resource = r.querySelector('.so-res').value; if (!resource) continue;
      const cols = r.querySelector('.so-cols').value.split(',').map((s) => s.trim()).filter(Boolean);
      out[op].push({ select: cols.length ? cols : ['*'], from: { resource, source: r.querySelector('.so-src').value } });
    }
    return out;
  }
  function havingRows() { return [...document.querySelectorAll('#bHaving .ca-row')].map((r) => ({ column: r.querySelector('.hv-col').value, operator: r.querySelector('.hv-op').value, value: Number(r.querySelector('.hv-val').value) })).filter((h) => h.column); }
  function windowRows() {
    return [...document.querySelectorAll('#bWindows .ca-row')].map((r) => {
      const fn = r.querySelector('.win-fn').value;
      const spec = { window: fn, alias: r.querySelector('.win-alias').value || 'w' };
      const col = r.querySelector('.win-col').value; if (col && !['RANK', 'DENSE_RANK', 'ROW_NUMBER'].includes(fn)) spec.column = col;
      const part = [...r.querySelector('.win-part').selectedOptions].map((o) => o.value).filter(Boolean); if (part.length) spec.partitionBy = part;
      const ord = r.querySelector('.win-ord').value; if (ord) spec.orderBy = [{ column: ord, direction: r.querySelector('.win-dir').value }];
      return spec;
    });
  }
  function aggRows() { return [...document.querySelectorAll('#bAggs .ca-row')].map((r) => ({ aggregate: r.querySelector('.agg-fn').value, column: r.querySelector('.agg-col').value, alias: r.querySelector('.agg-alias').value || 'value' })); }
  function argRows() { return [...document.querySelectorAll('#bArgs .ca-row')].map((r) => { const bind = r.querySelector('.arg-bind').checked; const v = r.querySelector('.arg-val').value; return bind ? `{{${v || 'arg'}}}` : coerceVal(v); }); }
  function manualVars() {
    return [...document.querySelectorAll('#bVars .ca-row')].map((r) => {
      const name = r.querySelector('.v-name').value.trim(); if (!name) return null;
      const type = r.querySelector('.v-type').value; let def = r.querySelector('.v-def').value;
      if (def === '') def = undefined; else if (type === 'number') def = Number(def); else if (type === 'boolean') def = (def === 'true');
      return { name, type, default: def, required: r.querySelector('.v-req').checked };
    }).filter(Boolean);
  }
  function schemaOf() { const m = RESMAP[val('bSource')] || {}; return m[val('bResource')] || 'public'; }

  function buildConfig() {
    // Advanced mode: the raw editor is the source of truth (arbitrary nested/complex AST).
    if (state.raw) {
      try { const parsed = JSON.parse(val('bRaw') || '{}'); return { config: parsed.config || parsed, variables: parsed.variables || manualVars() }; }
      catch (e) { return { config: { __invalid: e.message }, variables: manualVars() }; }
    }
    const type = state.type; const source = val('bSource'); const resource = val('bResource');
    const variables = manualVars();
    if (type === 'CALL') {
      const kind = val('bCallKind'); const name = val('bCallName');
      const cfg = { type: 'CALL', args: argRows() }; if (val('bCallSchema')) cfg.schema = val('bCallSchema'); cfg[kind] = name;
      return { config: cfg, variables };
    }
    const cols = [...state.cols];
    if (type === 'RECURSIVE') {
      const rec = { source, resource, connectBy: { parent: val('bRecParent'), child: val('bRecChild') }, anchor: [{ column: val('bRecAnchor'), operator: 'IS_NULL' }], direction: val('bRecDir'), select: cols.length ? cols : undefined, maxDepth: Number(val('bRecDepth')) || 10 };
      if (val('bRecPath')) rec.pathColumn = val('bRecPath');
      return { config: { type: 'SELECT', schema: schemaOf(), query: { recursive: rec } }, variables };
    }
    const fromCte = state.ctes.some((c) => c.name === resource);
    const q = { from: fromCte ? { resource } : { resource, source } };
    if (state.ctes.length) q.with = state.ctes.map((c) => ({ name: c.name, base: c.base }));
    const wins = windowRows();
    if (type === 'AGGREGATE') { const gb = [...state.groupBy]; q.groupBy = gb; q.select = [...gb, ...aggRows(), ...wins]; const hv = havingRows(); if (hv.length) q.having = hv; }
    else { q.select = [...(cols.length ? cols : (wins.length ? [] : ['*'])), ...wins]; if ($('bDistinct') && $('bDistinct').checked) q.distinct = true; }
    const wr = whereRows(); if (wr.length) q.where = wr;
    const or = orderRows(); if (or.length) q.orderBy = or;
    const joins = joinRows(); if (joins.length) { q.from.alias = 'a'; q.joins = joins; }
    // Set operations: wrap the base query as the first leg under the chosen op.
    const setops = setOpRows();
    for (const op of ['union', 'intersect', 'except']) {
      if (setops[op] && setops[op].length) {
        const base = { select: q.select, from: q.from }; if (q.where) base.where = q.where;
        return { config: { type: 'SELECT', schema: schemaOf(), limit: Number(val('bLimit')) || 50, query: { [op]: [base, ...setops[op]] } }, variables };
      }
    }
    return { config: { type: 'SELECT', schema: schemaOf(), limit: Number(val('bLimit')) || 50, query: q }, variables };
  }

  // auto-collect {{vars}} from the config text, merge into the variables panel
  function autoVarsFromConfig(config, declared) {
    const text = JSON.stringify(config);
    const found = [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];
    const have = new Set(declared.map((v) => v.name));
    const merged = declared.slice();
    found.filter((n) => !have.has(n)).forEach((n) => merged.push({ name: n, type: 'string', required: true }));
    return merged;
  }

  let sqlDebounce = null;
  window.setPreview = function (mode) {
    state.preview = mode;
    $('pvAst').classList.toggle('active', mode === 'AST');
    $('pvSql').classList.toggle('active', mode === 'SQL');
    renderPreview();
  };
  function showPreviewPane() { $('bPreviewPane').style.display = ''; $('caBody').classList.remove('no-preview'); if ($('bPreviewToggle')) $('bPreviewToggle').classList.add('active'); }
  window.toggleRaw = function () {
    state.raw = $('bRawOn').checked;
    if (state.raw) { showPreviewPane(); const { config, variables } = buildConfigVisual(); $('bRaw').value = JSON.stringify({ config, variables: autoVarsFromConfig(config, variables) }, null, 2); }
    $('bRaw').style.display = state.raw ? 'block' : 'none';
    renderPreview();
  };
  // buildConfig delegates to raw when advanced; buildConfigVisual is the form build.
  function buildConfigVisual() { const wasRaw = state.raw; state.raw = false; const r = buildConfig(); state.raw = wasRaw; return r; }

  window.renderPreview = function () {
    const { config, variables } = buildConfig();
    const vars = autoVarsFromConfig(config, variables);
    if (state.preview === 'SQL') {
      $('bPreview').textContent = '-- transpiling…';
      clearTimeout(sqlDebounce);
      sqlDebounce = setTimeout(async () => {
        try { const { data } = await post('/queries/transpile', { config }); $('bPreview').textContent = data.sql || '-- (no SQL)'; }
        catch (e) { $('bPreview').textContent = `-- transpile error: ${e.message}`; }
      }, 250);
    } else {
      // Show the actual query AST (what the engine runs), not the {config,variables} wrapper.
      const ast = config && config.query ? config.query : config;
      let text = JSON.stringify(ast, null, 2);
      if (vars.length) text += `\n\n// variables: ${JSON.stringify(vars)}`;
      $('bPreview').textContent = text;
    }
  };
  window.detectVars = function () {
    const { config, variables } = buildConfig();
    const vars = autoVarsFromConfig(config, variables);
    const have = new Set(variables.map((v) => v.name));
    vars.filter((v) => !have.has(v.name)).forEach((v) => addVar(v));
  };

  // ---------- test / save ----------
  function resolveDefaults(config, vars) {
    let text = JSON.stringify(config);
    for (const v of vars) { const d = v.default !== undefined ? v.default : (v.type === 'number' ? 0 : (v.type === 'boolean' ? false : '')); text = text.split(`"{{${v.name}}}"`).join(JSON.stringify(d)).split(`{{${v.name}}}`).join(String(d)); }
    return JSON.parse(text);
  }
  window.testBuild = async function () {
    const { config, variables } = buildConfig(); const vars = autoVarsFromConfig(config, variables);
    const box = $('bTest'); box.style.display = 'block'; box.innerHTML = 'Running…';
    try {
      const resolved = resolveDefaults(config, vars);
      const { ok, data } = await post('/analytics/query', { queryConfig: resolved });
      if (!ok) { box.innerHTML = `<span style="color:var(--danger,#dc2626);">✗ ${escapeHtml(data.error || 'failed')}</span>`; return; }
      const rows = data.data || []; const p = data.plan || {};
      box.innerHTML = `<div style="color:var(--primary);">✓ ${rows.length} row(s) · ${escapeHtml(p.strategy || '')} · ${escapeHtml(p.executionMs ?? '—')}ms</div>` +
        (rows[0] ? `<pre class="ca-code" style="max-height:120px; margin-top:.4rem;">${escapeHtml(JSON.stringify(rows[0], null, 2))}</pre>` : '');
    } catch (e) { box.innerHTML = `<span style="color:var(--danger,#dc2626);">✗ ${escapeHtml(e.message)}</span>`; }
  };
  window.saveBuild = async function () {
    const name = val('bName').trim(); if (!name) return showModal('Name required', 'Give the analytic a name.');
    const { config, variables } = buildConfig(); const vars = autoVarsFromConfig(config, variables);
    if (config && config.__invalid) return showModal('Invalid AST', config.__invalid);
    // A raw config carrying a top-level `sql` is saved as a SQL-mode analytic.
    const payload = (config && typeof config.sql === 'string')
      ? { name, description: val('bDesc').trim(), mode: 'SQL', sql: config.sql, source: config.source, variables: vars }
      : { name, description: val('bDesc').trim(), mode: 'AST', config, variables: vars };
    const { ok, data } = await post('/saved-analytics', payload);
    if (!ok) return showModal('Save failed', data.error || 'error');
    closeBuilder(); loadList();
  };

  // ---------- modal open/close ----------
  window.openBuilder = function () {
    $('builderTitle').textContent = 'Create analytic';
    ['bName', 'bDesc'].forEach((id) => { $(id).value = ''; });
    ['bWhere', 'bAggs', 'bOrders', 'bVars', 'bArgs', 'bJoins', 'bSetOps', 'bHaving', 'bWindows'].forEach((id) => { if ($(id)) $(id).innerHTML = ''; });
    if ($('bDistinct')) $('bDistinct').checked = false;
    state.ctes = []; refreshCtePicker(); renderCtes();
    $('bTest').style.display = 'none';
    state.raw = false; state.preview = 'AST'; if ($('bRawOn')) $('bRawOn').checked = false; $('bRaw').style.display = 'none'; $('bRaw').value = '';
    // Preview hidden by default → builder full width.
    $('bPreviewPane').style.display = 'none'; $('caBody').classList.add('no-preview'); if ($('bPreviewToggle')) $('bPreviewToggle').classList.remove('active');
    setPreview('AST'); setType('SELECT'); onBResource(); $('builderModal').style.display = 'flex';
  };
  // Universal edit — reopens the builder in advanced mode prefilled with the saved
  // config, so ANY analytic (simple or deeply nested/complex) can be edited + re-saved.
  function toRawEdit(cfg, variables) {
    $('bRawOn').checked = true; state.raw = true; showPreviewPane(); $('bRaw').style.display = 'block';
    $('bRaw').value = JSON.stringify({ config: cfg, variables: variables || [] }, null, 2);
    renderPreview();
  }
  /** Reverse-populate the VISUAL builder from a saved AST config so Edit shows the
   *  real controls (type, source, columns, filters, joins, windows, …) — falling
   *  back to the raw editor only for shapes the visual form can't represent. */
  // Ensure a source value is selectable even if the (cached) source list omitted it,
  // so Edit always reflects the saved analytic's source.
  function ensureSourceOption(name) {
    if (!name) return; const sel = $('bSource');
    if (![...sel.options].some((o) => o.value === name)) sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  }
  function ensureResourceOption(name) {
    if (!name) return; const sel = $('bResource');
    if (![...sel.options].some((o) => o.value === name)) sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
  }
  async function hydrateBuilder(config, variables) {
    const q = config.query || {};
    if (config.type === 'CALL') {
      setType('CALL');
      $('bCallKind').value = config.procedure ? 'procedure' : 'function';
      $('bCallName').value = config.function || config.procedure || '';
      if (config.schema && !String(config.schema).startsWith('tenant_')) $('bCallSchema').value = config.schema;
      (config.args || []).forEach((a) => { addArg(); const rows = document.querySelectorAll('#bArgs .arg-val'); rows[rows.length - 1].value = String(a); });
      (variables || []).forEach((v) => addVar(v)); renderPreview(); return;
    }
    if (q.recursive) {
      const r = q.recursive; setType('RECURSIVE');
      if (r.source) { ensureSourceOption(r.source); $('bSource').value = r.source; await onBSource(); }
      if (r.resource) { ensureResourceOption(r.resource); $('bResource').value = r.resource; await onBResource(); }
      if (r.connectBy) { $('bRecParent').value = r.connectBy.parent || ''; $('bRecChild').value = r.connectBy.child || ''; }
      if (r.anchor && r.anchor[0]) $('bRecAnchor').value = r.anchor[0].column || '';
      $('bRecDir').value = r.direction || 'down'; $('bRecDepth').value = r.maxDepth || 10; if (r.pathColumn) $('bRecPath').value = r.pathColumn;
      // recursive + outer aggregate is expressible; keep aggregate rows if present
      (variables || []).forEach((v) => addVar(v)); renderPreview(); return;
    }
    const op = q.union ? 'union' : q.intersect ? 'intersect' : q.except ? 'except' : null;
    const main = op ? (q[op][0] || {}) : q;
    const from = main.from || {};
    const isAgg = (Array.isArray(main.groupBy) && main.groupBy.length) || (Array.isArray(main.select) && main.select.some((c) => c && c.aggregate));
    setType(isAgg ? 'AGGREGATE' : 'SELECT');
    if (from.source) { ensureSourceOption(from.source); $('bSource').value = from.source; await onBSource(); }
    if (from.resource) { ensureResourceOption(from.resource); $('bResource').value = from.resource; await onBResource(); }
    for (const c of (main.select || [])) {
      if (typeof c === 'string') { if (c !== '*') state.cols.add(c); }
      else if (c && c.window) addWindow(c);
      else if (c && c.aggregate) addAgg(c);
      else if (c && c.column) state.cols.add(c.column);
    }
    (main.groupBy || []).forEach((g) => state.groupBy.add(g));
    renderColChips(); renderGroupByChips();
    (main.where || []).forEach((w) => { const bind = typeof w.value === 'string' && /^\{\{.*\}\}$/.test(w.value); addWhere({ column: w.column, operator: w.operator, value: bind ? '' : (Array.isArray(w.value) ? w.value.join(',') : w.value), bind }); });
    (main.having || []).forEach((h) => addHaving(h));
    (main.orderBy || []).forEach((o) => addOrder(o));
    (main.joins || []).forEach((j) => addJoin({ type: j.type, source: j.source, resource: j.resource, left: j.on && j.on.left, right: j.on && j.on.right }));
    if (main.distinct) $('bDistinct').checked = true;
    if (typeof config.limit === 'number') $('bLimit').value = config.limit;
    if (op) q[op].slice(1).forEach((leg) => addSetOp({ op: op.toUpperCase(), source: leg.from && leg.from.source, resource: leg.from && leg.from.resource, select: leg.select }));
    (variables || []).forEach((v) => addVar(v));
    renderPreview();
  }
  window.openEdit = async function (i) {
    const a = ANALYTICS[i];
    window.openBuilder();
    $('builderTitle').textContent = `Edit "${a.name}"`;
    $('bName').value = a.name; $('bDesc').value = a.description || '';
    if (a.mode === 'SQL') { toRawEdit({ sql: a.definition?.sql, source: a.definition?.source }, a.variables); return; }
    const config = a.definition?.config || {};
    // CTEs / deeply-nested shapes can't be represented by the visual controls → raw.
    if (config.query && config.query.with) { toRawEdit(config, a.variables); return; }
    try { await hydrateBuilder(config, a.variables || []); }
    catch (e) { toRawEdit(config, a.variables); }
  };
  window.closeBuilder = function () { $('builderModal').style.display = 'none'; };
  // Preview pane is hidden by default (more room for the builder); toggle to show it.
  window.togglePreviewPane = function () {
    const show = $('bPreviewPane').style.display === 'none';
    $('bPreviewPane').style.display = show ? '' : 'none';
    $('caBody').classList.toggle('no-preview', !show);
    $('bPreviewToggle').classList.toggle('active', show);
    if (show) renderPreview();
  };

  // ---------- list / play / result ----------
  let ANALYTICS = [];
  async function loadList() {
    ANALYTICS = await getJson('/saved-analytics') || [];
    $('caEmpty').style.display = ANALYTICS.length ? 'none' : 'block';
    $('caList').innerHTML = ANALYTICS.map((a, i) => `
      <div class="ca-item">
        <h4>${escapeHtml(a.name)} <span class="ca-badge">${escapeHtml(a.mode)}</span></h4>
        <div class="text-muted" style="font-size:.8rem; min-height:2.4em;">${escapeHtml(a.description || '')}</div>
        <div class="text-muted" style="font-size:.72rem; margin:.3rem 0;">${(a.variables || []).length} variable(s): ${escapeHtml((a.variables || []).map((v) => v.name).join(', ') || 'none')}</div>
        <div style="display:flex; gap:.4rem; margin-top:.6rem;">
          <button class="btn-primary" style="font-size:.8rem;" onclick="play(${i})"><i class="fas fa-play"></i> Play</button>
          <button class="btn-outline" style="font-size:.8rem;" onclick="openEdit(${i})"><i class="fas fa-pen"></i> Edit</button>
          <button class="btn-outline" style="font-size:.8rem;" onclick="delA('${escapeHtml(a.id)}')">Delete</button>
        </div>
      </div>`).join('');
  }
  window.play = function (i) {
    const a = ANALYTICS[i]; const vars = a.variables || [];
    if (!vars.length) return runA(a, {});
    $('playTitle').textContent = `Inputs for "${a.name}"`;
    $('playInputs').innerHTML = vars.map((v) => `
      <div class="ca-field"><label>${escapeHtml(v.label || v.name)} <span style="opacity:.7;">(${escapeHtml(v.type)})${v.required ? ' *' : ''}</span></label>
        <input class="ca-input pv" data-name="${escapeHtml(v.name)}" data-type="${escapeHtml(v.type)}" value="${escapeHtml(v.default ?? '')}"></div>`).join('');
    $('playRunBtn').onclick = () => {
      const values = {};
      document.querySelectorAll('#playInputs .pv').forEach((inp) => { let x = inp.value; if (x === '') return; if (inp.dataset.type === 'number') x = Number(x); else if (inp.dataset.type === 'boolean') x = (x === 'true'); values[inp.dataset.name] = x; });
      closePlay(); runA(a, values);
    };
    $('playModal').style.display = 'flex';
  };
  window.closePlay = function () { $('playModal').style.display = 'none'; };

  async function runA(a, values) {
    const { ok, data } = await post(`/saved-analytics/${a.id}/run`, { variables: values });
    if (!ok) return showModal('Run failed', data.error || 'error');
    renderResult(a, data);
  }
  function renderResult(a, r) {
    $('resultTitle').textContent = `▶ ${a.name}`;
    const bound = r.boundVariables || {};
    $('resultBound').textContent = Object.keys(bound).length ? 'Bound: ' + Object.entries(bound).map(([k, v]) => `${k}=${v}`).join(', ') : 'No variables.';
    const p = r.plan || {};
    $('resultKpis').innerHTML = [['Rows', r.rowCount ?? (r.data || []).length], ['Strategy', p.strategy || '—'], ['Exec', (p.executionMs ?? '—') + ' ms'], ['Scanned', p.rowsScannedAcrossSources ?? '—']]
      .map(([k, v]) => `<div style="background:var(--bg);border-radius:8px;padding:.6rem;text-align:center;"><div style="font-weight:700;font-size:1.2rem;">${escapeHtml(v)}</div><div class="text-muted" style="font-size:.7rem;">${escapeHtml(k)}</div></div>`).join('');
    const rows = r.data || []; const cols = rows.length ? Object.keys(rows[0]) : [];
    $('resultHead').innerHTML = '<tr>' + cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
    $('resultBody').innerHTML = rows.slice(0, 300).map((row) => '<tr>' + cols.map((c) => `<td>${escapeHtml(row[c])}</td>`).join('') + '</tr>').join('') || `<tr><td class="text-muted">0 rows</td></tr>`;
    $('resultPlan').innerHTML = (p.legs || []).map((l) => `<div style="background:var(--bg);border-radius:6px;padding:.4rem .6rem;margin:.3rem 0;font-size:.78rem;"><strong>${escapeHtml(l.source)}</strong> <span class="ca-badge">${escapeHtml(l.engine)}/${escapeHtml(l.mode)}</span> ${escapeHtml(l.operation)} → ${escapeHtml(l.rowsReturned)} rows · ${escapeHtml(l.ms)}ms</div>`).join('');
    $('resultModal').style.display = 'flex';
  }
  window.closeResult = function () { $('resultModal').style.display = 'none'; };
  window.delA = async function (id) { if (!confirm('Delete this analytic?')) return; await fetch(`${API_BASE}/saved-analytics/${id}`, { method: 'DELETE', headers: getAuthHeaders() }); loadList(); };

  // ---------- init ----------
  document.addEventListener('DOMContentLoaded', () => {
    $('bTypes').innerHTML = TYPES.map((t) => `<div class="ca-type" data-t="${t}" onclick="__setType('${t}')">${t}</div>`).join('');
    window.__setType = setType;
    ['bLimit', 'bCallName', 'bCallSchema', 'bRecDepth'].forEach((id) => { const e = $(id); if (e) e.addEventListener('input', renderPreview); });
    loadSources(); loadList();
  });
})();
