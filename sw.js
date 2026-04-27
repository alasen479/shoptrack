// ShopTrack Service Worker — Phase 1 Offline Support
// Strategy:
//   App shell (HTML, JS, fonts) → Cache-first, background update
//   Supabase / Netlify functions / AI / external APIs → Network-only (never cache)
//   Google Fonts → Cache-first (long-lived)
//   Everything else → Network-first, cache fallback
//   Offline → Serve cached app shell + show offline banner inside app

const CACHE_NAME   = 'shoptrack-shell-v37';
const OFFLINE_URL  = '/offline.html';

// ── App shell — these files make the app load instantly offline ──
const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/offline.html',
];

// ── Hosts that must NEVER be served from cache ───────────────────
const NETWORK_ONLY_HOSTS = [
  'supabase.co',           // database — always live data
  'netlify.app',           // functions
  'api.anthropic.com',     // AI
  'api.openai.com',        // DALL-E
  'api.brevo.com',         // email
  'campay.net',            // payments
  'stripe.com',            // payments
  'wa.me',                 // WhatsApp
  'fonts.gstatic.com',     // handled separately below
];

const FONT_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ── Install: pre-cache the app shell ─────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Add shell files — don't fail install if one is missing
      return Promise.allSettled(
        SHELL_URLS.map(function(url) {
          return cache.add(new Request(url, { cache: 'reload' })).catch(function(err) {
            console.warn('[SW] Could not cache:', url, err.message);
          });
        })
      );
    }).then(function() {
      // Activate immediately without waiting for old tabs to close
      return self.skipWaiting();
    })
  );
});

// ── Activate: clean up old caches ────────────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k)   { return caches.delete(k); })
      );
    }).then(function() {
      // Take control of all open tabs immediately
      return self.clients.claim();
    })
  );
});

// ── Fetch: routing logic ──────────────────────────────────────────
self.addEventListener('fetch', function(event) {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests — POST/PUT/DELETE go straight to network
  if (req.method !== 'GET') return;

  // ── 1. Network-only: Supabase, APIs, payment, AI ─────────────
  const isNetworkOnly = NETWORK_ONLY_HOSTS.some(function(h) {
    return url.hostname.includes(h);
  });
  if (isNetworkOnly) {
    event.respondWith(
      fetch(req).catch(function() {
        // Return a JSON error that app.js can handle gracefully
        return new Response(
          JSON.stringify({ error: 'offline', message: 'No internet connection' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // ── 2. Fonts: cache-first (they never change) ─────────────────
  const isFont = FONT_HOSTS.some(function(h) { return url.hostname.includes(h); });
  if (isFont) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        if (cached) return cached;
        return fetch(req).then(function(res) {
          if (!res || res.status !== 200) return res;
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
          return res;
        }).catch(function() { return new Response('', { status: 503 }); });
      })
    );
    return;
  }

  // ── 3. App shell (HTML + app.js): stale-while-revalidate ──────
  // Serve cached version instantly, then update cache in background.
  // Next load gets the fresh version.
  const isShell = url.origin === self.location.origin &&
    (url.pathname === '/' ||
     url.pathname === '/index.html' ||
     url.pathname === '/app.js' ||
     url.pathname === '/booking.html' ||
     url.pathname === '/offline.html');

  if (isShell) {
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache) {
        return cache.match(req).then(function(cached) {
          // Fetch fresh copy in background
          var fetchPromise = fetch(req).then(function(res) {
            if (res && res.status === 200) {
              cache.put(req, res.clone());
            }
            return res;
          }).catch(function() { return null; });

          // Return cached immediately if available, else wait for network
          if (cached) {
            // Background update — don't await it
            fetchPromise.catch(function() {});
            return cached;
          }
          // No cache yet — wait for network, fallback to offline page
          return fetchPromise.then(function(res) {
            return res || caches.match(OFFLINE_URL);
          });
        });
      })
    );
    return;
  }

  // ── 4. Netlify functions: network-only (they hit DB/APIs) ─────
  if (url.pathname.startsWith('/.netlify/functions/')) {
    event.respondWith(
      fetch(req).catch(function() {
        return new Response(
          JSON.stringify({ error: 'offline', message: 'No internet connection' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // ── 5. PDFs and static assets: cache-first ────────────────────
  if (url.pathname.match(/\.(pdf|png|jpg|jpeg|svg|ico|woff2|woff|ttf)$/)) {
    event.respondWith(
      caches.match(req).then(function(cached) {
        if (cached) return cached;
        return fetch(req).then(function(res) {
          if (res && res.status === 200) {
            var clone = res.clone();
            caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
          }
          return res;
        }).catch(function() { return new Response('', { status: 503 }); });
      })
    );
    return;
  }

  // ── 6. Everything else: network-first, cache fallback ─────────
  event.respondWith(
    fetch(req).then(function(res) {
      if (res && res.status === 200) {
        var clone = res.clone();
        caches.open(CACHE_NAME).then(function(c) { c.put(req, clone); });
      }
      return res;
    }).catch(function() {
      return caches.match(req).then(function(cached) {
        return cached || caches.match(OFFLINE_URL);
      });
    })
  );
});

// ── Message handler: force update on demand ───────────────────────
self.addEventListener('message', function(event) {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
