/* Zero Data Fabric landing: theme toggle, sticky-nav shadow, mobile menu, reveal on scroll. The plans section is filled from GET /api/plans (static cards stay if it fails). */
(function () {
  'use strict';
  var KEY = 'df-theme';
  var root = document.documentElement;

  function setTheme(t) {
    root.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f6f7fd' : '#0c0e1b');
  }

  var toggle = document.getElementById('lpTheme');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      setTheme(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    });
  }

  // follow the system only while the visitor has not picked a theme
  try {
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var onChange = function (e) {
      var saved = null;
      try { saved = localStorage.getItem(KEY); } catch (err) { /* ignore */ }
      if (!saved) setTheme(e.matches ? 'light' : 'dark');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  } catch (e) { /* ignore */ }

  var nav = document.getElementById('top');
  function onScroll() { if (nav) nav.classList.toggle('lp-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  var btn = document.getElementById('lpMenuBtn');
  var menu = document.getElementById('lpMenu');
  function closeMenu() {
    if (!menu || !btn) return;
    menu.classList.remove('lp-open');
    btn.setAttribute('aria-expanded', 'false');
  }
  if (btn && menu) {
    btn.addEventListener('click', function () {
      var open = menu.classList.toggle('lp-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.addEventListener('click', function (e) { if (e.target && e.target.closest && e.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', function () { if (window.innerWidth > 820) closeMenu(); });
  }

  var items = document.querySelectorAll('.lp-reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('lp-in'); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add('lp-in'); });
  }
  // ---- plans: render the plans configured in the system, with their enabled limits and features ----
  var plansEl = document.getElementById('lpPlans');
  var LIMITS = [
    ['max_connections', 'data connections'], ['max_tables', 'tables'], ['max_records_per_table', 'records per table'],
    ['max_triggers', 'triggers'], ['max_replication_tables', 'replicated tables'], ['max_replication_rows', 'replicated rows']
  ];
  var RATES = [['rate_limit_per_min', 'min'], ['rate_limit_per_hour', 'hour'], ['rate_limit_per_day', 'day'], ['rate_limit_per_month', 'month']];
  var FEATURES = [
    ['custom_branding', 'Custom branding'], ['enterprise_sso_enabled', 'Enterprise SSO'], ['elasticsearch_enabled', 'Elasticsearch connector'],
    ['snowflake_enabled', 'Snowflake connector'], ['cdc_kafka_enabled', 'CDC replication (Kafka)'], ['federated_query_enabled', 'Federated queries'],
    ['distributed_execution_enabled', 'Distributed execution'], ['developer_tokens_enabled', 'Developer API tokens'],
    ['manifest_import_export_enabled', 'Manifest import / export']
  ];
  function esc(v) { return String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n).toLocaleString('en-US'); }
  function title(name) { return String(name).replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function planCard(p, featured) {
    var limits = p.limits || {}, feats = p.features || {}, items = [];
    var price = Number(p.price_monthly);
    var trial = feats.trial_period_days;
    LIMITS.forEach(function (l) {
      if (limits[l[0]] === undefined || limits[l[0]] === null) return;
      items.push(limits[l[0]] < 0 ? 'Unlimited ' + l[1] : 'Up to ' + num(limits[l[0]]) + ' ' + l[1]);
    });
    RATES.some(function (r) {
      if (limits[r[0]] === undefined || limits[r[0]] === null) return false;
      items.push(limits[r[0]] < 0 ? 'Unlimited API requests' : num(limits[r[0]]) + ' API requests per ' + r[1]);
      return true;
    });
    FEATURES.forEach(function (f) { if (feats[f[0]] === true) items.push(f[1]); });
    if (typeof trial === 'number') items.unshift(trial < 0 ? 'No trial limit' : trial + '-day trial');
    var sub = p.is_default ? 'Included for every new workspace.' : p.is_custom ? 'Tailored limits for your workspace.' : 'Available for your workspace.';
    var badge = p.is_default ? '<span class="' + (featured ? 'lp-plan-badge' : 'lp-plan-badge-soft') + '">Start here</span>' : '';
    var cta = p.is_default || price === 0
      ? '<a class="lp-btn ' + (featured ? 'lp-btn-primary' : 'lp-btn-secondary') + ' lp-btn-block" href="/login">' + (trial > 0 ? 'Start free trial' : 'Get started') + '</a>'
      : '<a class="lp-btn ' + (featured ? 'lp-btn-primary' : 'lp-btn-secondary') + ' lp-btn-block" href="mailto:fabric@fabrixly.com?subject=' + encodeURIComponent(title(p.name) + ' plan inquiry') + '">Contact us</a>';
    return '<article class="lp-plan lp-in' + (featured ? ' lp-plan-featured' : '') + '">' + badge +
      '<h3>' + esc(title(p.name)) + '</h3>' +
      '<p class="lp-plan-price">' + (price > 0 ? '$' + price.toFixed(2).replace(/\.00$/, '') + '<small> / month</small>' : 'Free') + '</p>' +
      '<p class="lp-plan-sub">' + sub + '</p>' +
      '<ul class="lp-ticks lp-small">' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' + cta + '</article>';
  }
  if (plansEl && window.fetch) {
    var base = (plansEl.getAttribute('data-api') || '').replace(/\/+$/, '');
    fetch(base + '/api/plans', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (plans) {
        if (!Array.isArray(plans) || !plans.length) return;
        var sorted = plans.slice().sort(function (a, b) { return Number(a.price_monthly) - Number(b.price_monthly) || String(a.name).localeCompare(b.name); });
        var featuredIdx = sorted.length > 2 ? 1 : -1;
        plansEl.innerHTML = sorted.map(function (p, i) { return planCard(p, i === featuredIdx); }).join('');
        var sub = document.getElementById('lpPlansSub');
        if (sub) sub.textContent = 'Live from the plans configured on this installation: limits and features shown are what each plan enables.';
      })
      .catch(function () { /* keep the static cards */ });
  }
})();
