/* Only public offline resources belong in this cache. No private responses or visitor events. */
const CACHE_PREFIX = 'aa-portfolio-public-offline-';
const CACHE_NAME = CACHE_PREFIX + 'p05';
const base = new URL(self.registration.scope);
const offline = new URL('./offline.html', base).href;
const fonts = ['./assets/cairo-arabic.woff2', './assets/cairo-latin.woff2'].map(path => new URL(path, base).href);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll([offline, ...fonts])));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)),
  )));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('Authorization')) return;
  const url = new URL(request.url);
  if (url.origin !== base.origin) return;
  if (fonts.includes(url.href)) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match(request)) || fetch(request)));
    return;
  }
  const appDocument = url.pathname === base.pathname || url.pathname === new URL('./index.html', base).pathname;
  if (request.mode !== 'navigate' || !appDocument) return;
  event.respondWith(fetch(request).catch(async () => {
    const cached = await caches.open(CACHE_NAME).then(cache => cache.match(offline));
    return cached || new Response('', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }));
});
