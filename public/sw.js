// Bot HQ service worker: shows pushes, opens the right screen on tap, keeps the shell for offline.
const CACHE = "bot-hq-v1";
const SHELL = ["/", "/styles.css", "/app.js", "/manifest.webmanifest", "/fonts/bricolage.woff2",
  "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so a deploy shows up at once), cache when offline. The API is never cached.
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
    return res;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match("/"))));
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: event.data?.text() || "Bot HQ" }; }
  const title = data.title || "Bot HQ";
  const shown = self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: data.url || "/#/inbox" },
  });
  const badge = Number.isFinite(data.badge) && self.navigator.setAppBadge
    ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge())
    : Promise.resolve();
  event.waitUntil(Promise.all([shown, badge.catch(() => {})]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/#/inbox", location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (client.url.startsWith(location.origin)) {
        client.postMessage({ type: "open", url: target });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
