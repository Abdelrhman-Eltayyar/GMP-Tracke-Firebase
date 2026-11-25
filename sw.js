/* GMP Tracker — Service Worker
   • الصفحة: network-first (مهلة 4 ث) ثم نسخة محفوظة → التحديثات تصل فور رفعها، ويعمل التطبيق بدون إنترنت.
   • مكتبات CDN والخطوط: cache-first (روابطها مثبّتة بالإصدار).
   • لا نتدخل أبداً في طلبات Firebase/Firestore/Auth.
   غيّر VERSION عند كل تحديث لـ index.html إن أردت إجبار تحديث الكاش فوراً. */
const VERSION = 'gmp-v1.1.0';
const SHELL_CACHE = 'gmp-shell-' + VERSION;
const CDN_CACHE = 'gmp-cdn-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const CDN_PRECACHE = [
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage-compat.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];
const FONT_CSS = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Tajawal:wght@400;500;700;800;900&display=swap";

function cdnAllowed(u) {
  return (u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) ||
         u.hostname === 'cdnjs.cloudflare.com' || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com';
}
async function cdnFetch(req) {            // نفضّل CORS (حجم حقيقي في الكاش)، وإلا نرجع للطلب الأصلي
  const url = typeof req === 'string' ? req : req.url;
  try { const r = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (r.ok) return r; } catch (e) {}
  try { return await fetch(typeof req === 'string' ? new Request(url, { mode: 'no-cors' }) : req); } catch (e) { return null; }
}
const sleepNull = ms => new Promise(res => setTimeout(() => res(null), ms));
const sleepReject = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const skipNow = self.skipWaiting();
    const shell = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map(u => shell.add(new Request(u, { cache: 'reload' }))));
    const cdn = await caches.open(CDN_CACHE);
    await skipNow;
    await Promise.allSettled(CDN_PRECACHE.map(async u => { const r = await Promise.race([cdnFetch(u), sleepNull(10000)]); if (r && (r.ok || r.type === 'opaque')) await cdn.put(u, r); }));
    try {                                  // الخط: ملف CSS + شريحتا arabic/latin فقط
      const r = await Promise.race([fetch(FONT_CSS, { mode: 'cors' }), sleepNull(10000)]);
      if (!r) throw new Error('font css timeout');
      if (r.ok) {
        const css = await r.clone().text();
        await cdn.put(FONT_CSS, r);
        const urls = [];
        css.replace(/\/\*\s*(arabic|latin)\s*\*\/\s*@font-face\s*\{[^}]*?url\((https:[^)]+)\)/g, (_, __, u) => urls.push(u));
        await Promise.allSettled(urls.map(async u => { const fr = await Promise.race([cdnFetch(u), sleepNull(10000)]); if (fr && (fr.ok || fr.type === 'opaque')) await cdn.put(u, fr); }));
      }
    } catch (e) {}
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('gmp-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function networkFirstNav(req) {
  const cache = await caches.open(SHELL_CACHE);
  const netP = fetch(req);
  try {
    const net = await Promise.race([netP, sleepReject(4000)]);
    if (net && net.ok) { cache.put('index.html', net.clone()); cache.put('./', net.clone()); }
    return net;
  } catch (e) {
    const cached = (await cache.match('index.html', { ignoreSearch: true })) || (await cache.match('./', { ignoreSearch: true }));
    if (cached) return cached;
    try { return await netP; } catch (e2) { return Response.error(); }
  }
}
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()); return r; }).catch(() => null);
  return cached || (await fetching) || Response.error();
}
async function cdnCacheFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const cached = await cache.match(req.url);
  if (cached) {
    if (req.url.startsWith('https://fonts.googleapis.com')) cdnFetch(req).then(r => { if (r && r.ok) cache.put(req.url, r); });
    return cached;
  }
  const r = await cdnFetch(req);
  if (r && (r.ok || r.type === 'opaque')) cache.put(req.url, r.clone());
  return r || Response.error();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') event.respondWith(networkFirstNav(req));
    else event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }
  if (cdnAllowed(url)) event.respondWith(cdnCacheFirst(req));
});
