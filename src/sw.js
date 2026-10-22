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
  // Texto discreto na tela bloqueada: sem nome, unidade, rastreio ou loja.
  event.waitUntil(self.registration.showNotification(String(data?.title || 'Portaria Prime').slice(0, 60), {
    body: 'Há uma atualização da portaria. Toque para abrir.',
    tag: data?.url || 'portaria-prime',
    icon: '/pwa-192x192.png', badge: '/pwa-64x64.png',
    data: { url: target.origin === self.location.origin ? target.pathname : '/app' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/app';
  // Reaproveita uma janela aberta do app em vez de abrir outra.
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => new URL(c.url).origin === self.location.origin);
    return win ? win.navigate(url).then(c => (c || win).focus()) : self.clients.openWindow(url);
  }));
});
