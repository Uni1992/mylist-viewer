const cacheName = "tonite-viewer-v21";
const assets = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./logos/netflix.svg",
  "./logos/prime.svg",
  "./logos/disney.svg",
  "./logos/appletv.svg",
  "./logos/unext.svg"
];

self.addEventListener("install", (event) => {
  // 新しいSWを待たせず即座に有効化する（更新が1回の再読み込みで届くように）
  self.skipWaiting();
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))),
      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // 外部通信（GitHub同期・ポスター画像等）にはSWを一切介在させない。
  // iOSのPWAではSW経由の認証付きクロスオリジン通信が失敗することがあるため
  if (url.origin !== location.origin) return;
  // アプリ本体はネットワーク優先: デプロイが次の読み込みで即反映され、オフライン時だけキャッシュを使う
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(cacheName).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
