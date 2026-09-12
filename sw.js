/* Service worker : coque applicative hors ligne + cache des ressources CDN. */

const VERSION = 'pikview-v4';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/analyze.js',
  'js/camera.js',
  'js/vision.js',
  'js/rectify.js',
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

/**
 * Deux régimes, selon ce que la ressource devient avec le temps.
 *
 * Le code de l'application change à chaque déploiement : il est demandé au
 * réseau d'abord, le cache ne servant que de secours hors ligne. L'ancienne
 * version répondait depuis le cache et ne rafraîchissait que pour la fois
 * suivante : une mise en ligne ne se voyait qu'au deuxième rechargement, ce
 * qui donnait un site en retard d'une version sans que rien ne le signale.
 *
 * Les ressources du CDN, elles, sont figées à une version donnée par leur
 * URL : les redemander n'apprendrait rien et coûterait le retéléchargement du
 * moteur de reconnaissance, plusieurs mégaoctets. Cache d'abord, donc.
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // La navigation retombe sur la coque, pas sur la page demandée.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, 'index.html'));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const runtime = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !runtime) return;

  event.respondWith(sameOrigin ? networkFirst(request, request) : cacheFirst(request));
});

function keep(cacheKey, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  const copy = res.clone();
  caches.open(VERSION).then((c) => c.put(cacheKey, copy)).catch(() => {});
}

async function networkFirst(request, cacheKey) {
  try {
    // `no-cache` revalide auprès du serveur au lieu de croire le cache HTTP du
    // navigateur : sans cela, un fichier déjà remplacé peut encore être
    // resservi pendant toute sa durée de fraîcheur, et le détour par le réseau
    // ne garantirait plus rien. La revalidation ne retransfère pas les octets
    // quand le fichier n'a pas bougé.
    const res = await fetch(new Request(request, { cache: 'no-cache' }));
    keep(cacheKey, res);
    return res;
  } catch {
    const cached = await caches.match(cacheKey);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await caches.match('./');
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  keep(request, res);
  return res;
}
