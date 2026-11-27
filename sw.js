const CACHE_NAME = "creativavto-pwa-v26";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./sw.js"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Не вмешиваемся в POST запросы (оплата, ИИ) и запросы к API
  if (event.request.method !== "GET") return;
  
  const url = new URL(event.request.url);
  // Если это запрос к Firestore, ЮKassa или Yandex Cloud — пропускаем (не кэшируем)
  if (url.origin.includes("firestore.googleapis.com") || 
      url.origin.includes("yookassa.ru") || 
      url.origin.includes("yandexcloud.net")) {
    return;
  }

  // Для своих файлов используем Network-first, но с фолбэком на кэш
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Кэшируем успешные ответы для статики
        if (response.ok && url.origin === self.location.origin) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => {
        // Если сети нет, отдаем из кэша. Если нет в кэше — отдаем главную страницу
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          // Фолбэк для навигации
          if (event.request.mode === 'navigate') {
            return caches.match("./index.html");
          }
        });
      })
  );
});

self.addEventListener("push", (event) => {
  let title = "CreativAvto Тамбов";
  let body = "Новое уведомление от автосервиса";

  if (event.data) {
    try {
      const json = event.data.json();
      if (json.title) title = json.title;
      if (json.body) body = json.body;
    } catch (_) {
      body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: "./icon-180.png",
      badge: "./icon-180.png",
      tag: "creativavto-" + Date.now(),
      renotify: true
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      if (list.length > 0) return list[0].focus();
      return clients.openWindow("./");
    })
  );
});
