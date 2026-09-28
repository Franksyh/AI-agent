
const CACHE_NAME = "mini-codex-cloud-shell-v9";
const APP_SHELL = [
  "/",
  "/index.html",
  "/mini-codex-cloud.css",
  "/mini-codex-cloud.js",
  "/manifest.webmanifest",
  "/assets/mini-robot.svg",
  "/assets/mini-robot-192.png",
  "/assets/mini-robot-512.png",
  "/assets/apple-touch-icon.png",
  "/privacy.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/")) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match("/index.html"))));
});
