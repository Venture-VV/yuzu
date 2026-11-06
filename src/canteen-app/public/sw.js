// 柚子饭堂的离线外壳（docs/CANTEEN.md 第 3 节）：只缓存页面外壳与静态资源，从不缓存 /api/*。
// 打开页面：先走网络，断网时用上次的外壳（饭卡码在手机上离线生成，没网也能亮码）。
// 静态资源带内容摘要（/assets/…），缓存优先；页面每次打开把当前用到的资源告诉这里，旧的清掉。
const CACHE = 'yuzu-canteen-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

// 页面告诉这里当前用到的资源：没缓存的补上，不再用的旧资源删掉
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const keep = new Set(data.urls.map((u) => new URL(u, self.location.origin).pathname));
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path.startsWith('/assets/') && !keep.has(path)) await cache.delete(req);
      }
      for (const path of keep) {
        if (path.startsWith('/assets/') && !(await cache.match(path))) await cache.add(path).catch(() => undefined);
      }
    })(),
  );
});
