/* Zero Data Fabric landing: theme toggle, sticky-nav shadow, mobile menu, reveal on scroll. No network requests. */
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
})();
