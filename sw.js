// Работа без интернета для приложения на экране «Домой»: сначала сеть (всегда свежая версия),
// без сети — последняя сохранённая копия файлов приложения.
const CACHE = 'kb-app-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  const lib = /cdn\.jsdelivr\.net|telegram\.org/.test(url.host);
  if (!own && !lib) return; // облако бота и прочее — без кэша
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (own || lib)) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('./index.html') || await caches.match('./'); if (idx) return idx; }
      throw err;
    }
  })());
});
