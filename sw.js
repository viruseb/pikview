/* Service worker : coque applicative hors ligne + cache des ressources CDN. */

const VERSION = 'pikview-v2';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/analyze.js',
  'js/camera.js',
  'js/vision.js',
  'js/ocr.js',
  'js/overlay.js',
  'js/solver.js',
  'js/solver-worker.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then(async (cache) => {
      // addAll échoue en bloc : on tolère les absences individuelles.
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Navigation : réseau d'abord, coque en secours (lancement hors ligne).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const runtime = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !runtime) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok && res.type !== 'opaque') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
