/* global caches, clients, self, Response */
const CACHE = 'memo-v1';

const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './lib/crypto.js',
  './lib/format.js',
  './lib/util.js',
  'https://cdn.jsdelivr.net/npm/openpgp@6.3.1/dist/openpgp.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.0/build/highlight.min.js',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.0/build/styles/github-dark.min.css',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/lib/codemirror.css',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/theme/material-darker.css',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/theme/material.css',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/lib/codemirror.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/markdown/markdown.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/javascript/javascript.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/xml/xml.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/css/css.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/htmlmixed/htmlmixed.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/python/python.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/shell/shell.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/yaml/yaml.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/sql/sql.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/mode/lua/lua.js',
  'https://cdn.jsdelivr.net/npm/codemirror@5.65.18/addon/edit/matchbrackets.js',
  'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js',
];

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // GitHub API — network first
  if (url.hostname === 'api.github.com') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Local assets and CDN — cache first
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}
