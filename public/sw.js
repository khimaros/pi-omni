const CACHE_NAME = 'pi-omni-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/state.js',
  '/components.js',
  '/audio.js',
  '/ptt.js',
  '/worklet.js',
  '/icon.png',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  // bypass cache for websocket and vendor assets which might be large or dynamic
  if (event.request.url.includes('/ws') || event.request.url.includes('/vendor/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
