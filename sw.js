/* ExamShield — service worker: abre offline, atualiza online, nunca guarda /api/ */
const V = 'examshield-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') {            // página: rede primeiro (apanha atualizações), cache se estiver offline
    e.respondWith(
      fetch(r).then(x => { const c = x.clone(); caches.open(V).then(k => k.put('/index.html', c)); return x; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  e.respondWith(                           // restantes ficheiros e bibliotecas: cache e atualização em segundo plano
    caches.match(r).then(hit => {
      const net = fetch(r).then(x => {
        if (x && (x.ok || x.type === 'opaque')) { const c = x.clone(); caches.open(V).then(k => k.put(r, c)); }
        return x;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
