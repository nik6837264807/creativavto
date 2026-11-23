const CACHE_NAME = "creativavto-pwa-14";
const ASSETS = Array.of(
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "CreativAvto Тамбов", body: "Новое сообщение от мастера Николая" };
  try {
    if (event.data) payload = event.data.json();
  } catch (_) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "CreativAvto Тамбов", {
      body: payload.body || "",
      icon: "./icon-180.png",
      badge: "./icon-180.png",
      vibrate: Array.of(200, 100, 200)
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list.at(0).focus();
      return clients.openWindow("./");
    })
  );
});
