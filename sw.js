// Offline support: the app's own files are cached on install and refreshed
// from the network whenever it's reachable (network first, cache fallback),
// so updates show up straight away and a venue with flaky wifi still works.

const CACHE = 'chop-shop-v3';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/tone-15.1.22.js',
  'src/audio-utils.js',
  'src/composer.js',
  'src/engine.js',
  'src/main.js',
  'src/moods.js',
  'src/patches.js',
  'src/recorder.js',
  'src/rng.js',
  'src/slicer.js',
  'src/theory.js',
  'src/visualizer.js',
  'src/viz.js',
  'src/wav.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
