// 柚子饭堂的离线外壳（docs/CANTEEN.md 第 3 节）：只缓存页面外壳与静态资源，从不缓存 /api/*；饭点提醒的推送也在这里（第 19 节，文件末尾）。
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

// ── 饭点提醒（docs/CANTEEN.md 第 19 节）：门店系统发来的推送 ──
// 弹一条通知（同一个 tag 的新的换掉旧的），桌面上的柚子图标点上小红点（支持的手机：iPhone 16.4 起、电脑上装成应用的 Chrome、Edge）；
// 点通知：柚子饭堂开着就切过去、打开那一页，没开就打开。内容是门店系统加密发来的 JSON：{ title, body, tag, url, badge }
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : '' };
  }
  const url = typeof msg.url === 'string' && msg.url.startsWith('/') && !msg.url.startsWith('//') ? msg.url : '/';
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(typeof msg.title === 'string' && msg.title ? msg.title : '柚子饭堂', {
        body: typeof msg.body === 'string' ? msg.body : '',
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        tag: typeof msg.tag === 'string' && msg.tag ? msg.tag : 'yuzu',
        renotify: true,
        lang: 'zh-CN',
        data: { url },
      });
      const n = Number(msg.badge);
      if (n > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(n).catch(() => undefined);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge().catch(() => undefined);
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        open.postMessage({ type: 'open', hash: target.hash });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});

// 浏览器换了订阅（钥匙过期等）：把新的交给门店系统（登录着才收；没登录的下次打开柚子饭堂时再核对）
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const next = event.newSubscription || (old && old.options ? await self.registration.pushManager.subscribe(old.options).catch(() => null) : null);
      if (!next) return;
      await fetch('/api/canteen/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next.toJSON()),
      }).catch(() => undefined);
    })(),
  );
});
