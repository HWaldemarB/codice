/* Códice — service worker: guarda la app en el teléfono para usarla sin señal.
   Las notas NO pasan por acá: viven en el almacenamiento interno (IndexedDB). */
const VERSION = 'codice-v1.59-3';
const ASSETS = [
  './',
  './index.html',
  './codice-interno.js',
  './codice-copias.js',
  './manifest.webmanifest',
  './vendor/marked.min.js',
  './vendor/purify.min.js',
  './vendor/jszip.min.js',
  './icons/guia-180.png',
  './icons/guia-192.png',
  './icons/guia-512.png',
  './icons/guia-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;               // GuIA (POST) va directo a la red
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // APIs externas: sin caché

  // Página principal: primero la red (para recibir mejoras), si no hay señal → copia guardada
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const fresh = await fetch(req, { signal: ctrl.signal });
        clearTimeout(t);
        if (fresh && fresh.ok) {
          const c = await caches.open(VERSION);
          c.put('./index.html', fresh.clone());
        }
        return fresh;
      } catch (e) {
        const c = await caches.open(VERSION);
        return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Resto de archivos de la app: copia guardada primero, actualiza en segundo plano
  event.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await net) || Response.error();
  })());
});
