// משותף לכל הדפים: שם המשתמש + "יציאה" בפס העליון, הסתרת קישורים לאתרים בלי הרשאה (data-need="items" וכו'),
// ומעבר למסך הכניסה כשהחיבור פג (תשובת 401 מה-API).
(function () {
  const toLogin = () => { location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    const url = String(args[0] && args[0].url || args[0] || '');
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) toLogin();
    return res;
  };
  window.AUTH = { me: null, ready: null };
  window.AUTH.ready = origFetch('/api/auth/me', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(me => {
    window.AUTH.me = me;
    if (!me) return me;
    document.querySelectorAll('[data-need]').forEach(el => { if (!me.access.includes(el.dataset.need)) el.remove(); });
    document.querySelectorAll('[data-admin-only]').forEach(el => { if (!me.is_admin) el.remove(); });
    const strip = document.querySelector('.site-strip');
    if (strip && me.user) {
      const span = document.createElement('span');
      span.className = 'strip-user';
      span.innerHTML = ' · <span></span> · <a href="#" style="color:inherit;text-decoration:underline;">יציאה</a>';
      span.querySelector('span').textContent = me.user.name;
      span.querySelector('a').onclick = async (e) => {
        e.preventDefault();
        if (!confirm('לצאת מהמערכת במכשיר הזה?')) return;
        await origFetch('/api/auth/logout', { method: 'POST' });
        location.href = '/login.html';
      };
      strip.appendChild(span);
    }
    return me;
  }).catch(() => null);
})();
