/* Studio Devis · fichiers de l'application gardés sur l'appareil (ouverture sans réseau).
 * Avec internet, la dernière version est toujours reprise ; sans internet, la copie gardée est servie.
 * Le devis en ligne des clients (dossier devis/) n'est pas concerné. */
const CACHE = 'studio-devis-v1';
const FICHIERS = ['./', 'index.html', 'hors-ligne.js', 'manifest.webmanifest', 'favicon.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((l) => Promise.all(l.filter((k) => k !== CACHE && k.indexOf('studio-devis') === 0).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const portee = new URL(self.registration.scope);
  // fichiers de l'application : le réseau d'abord, la copie gardée sinon
  if (u.origin === portee.origin && u.pathname.indexOf(portee.pathname) === 0 && u.pathname.indexOf(portee.pathname + 'devis/') !== 0) {
    e.respondWith(fetch(r).then((rep) => {
      if (rep && rep.ok) { const c = rep.clone(); caches.open(CACHE).then((x) => x.put(r, c)); }
      return rep;
    }).catch(() => caches.match(r, { ignoreSearch: true })
      .then((m) => m || (r.mode === 'navigate' ? caches.match('index.html') : undefined))
      .then((m) => m || Response.error())));
    return;
  }
  // polices Poppins (Google Fonts) : la copie gardée d'abord
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(r).then((m) => m || fetch(r).then((rep) => {
      if (rep && (rep.ok || rep.type === 'opaque')) { const c = rep.clone(); caches.open(CACHE).then((x) => x.put(r, c)); }
      return rep;
    })));
  }
});
