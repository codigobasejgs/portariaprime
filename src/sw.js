import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

// Somente arquivos estáticos versionados. Sem cache de API, Storage, QR ou dados pessoais.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('push', event => {
  let data;
  try { data = event.data?.json(); } catch { data = null; }
  const target = new URL(data?.url || '/app', self.location.origin);
  event.waitUntil(self.registration.showNotification('Portaria Prime', {
    body: 'Há uma atualização no sistema. Entre para consultar.',
    icon: '/pwa-192x192.png', badge: '/pwa-64x64.png',
    data: { url: target.origin === self.location.origin ? target.pathname : '/app' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app';
  event.waitUntil(self.clients.openWindow(url));
});
