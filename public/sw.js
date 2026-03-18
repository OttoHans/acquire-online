self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'ACQUIRE';
  const options = {
    body: data.body || "It's your turn!",
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'acquire-turn',
    renotify: true,
    data: { pin: data.pin },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const pin = event.notification.data && event.notification.data.pin;
  const url = pin ? `/?pin=${pin}` : '/';
  event.waitUntil(clients.matchAll({ type: 'window' }).then(cs => {
    for (const c of cs) { if (c.url.includes(url) && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
