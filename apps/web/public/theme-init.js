// Before first paint (D118): the reader's chosen theme, else the system's. A classic, external,
// same-origin script — the CSP this server sends (apps/server/src/routes/static.ts) has no
// 'unsafe-inline' and no script hash, so an inline script would silently never run.
(function () {
  var t;
  try {
    t = localStorage.getItem('bookclub:theme');
    if (t !== 'vellum' && t !== 'lucerna') {
      t = matchMedia('(prefers-color-scheme: dark)').matches ? 'lucerna' : 'vellum';
    }
  } catch (e) {
    t = 'lucerna';
  }
  document.documentElement.dataset.theme = t;
})();
