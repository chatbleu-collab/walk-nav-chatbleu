/* ============================================================
   걷기 내비 - 서비스워커
   ------------------------------------------------------------
   업데이트 정책
   - 앱 파일(html/css/js): 네트워크 우선 → GitHub에 올리면 자동 반영
   - 지도 타일 / 외부 라이브러리: 캐시 우선 → 빠르고 데이터 절약
   - 인터넷이 없으면 캐시된 내용으로 정상 동작

   → 버전 숫자를 손으로 올릴 필요가 없습니다.
     (아래 CACHE_VERSION은 캐시를 통째로 비우고 싶을 때만 올리세요)
   ============================================================ */

const CACHE_VERSION = 1;
const CACHE_NAME = 'walk-nav-v' + CACHE_VERSION;

// 오프라인에서도 앱이 켜지려면 반드시 있어야 하는 파일
const CORE_ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 외부 CDN (실패해도 설치를 막지 않음)
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/* ------------------------------------------------------------
   설치
   ------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 핵심 파일은 항상 최신본으로 받아 캐시에 넣음
    await Promise.all(CORE_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) {}
    }));

    // CDN은 있으면 좋고 없으면 나중에
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (res && res.ok) await cache.put(url, res);
      } catch (e) {}
    }));

    // 새 버전을 바로 대기열에서 꺼냄
    await self.skipWaiting();
  })());
});

/* ------------------------------------------------------------
   활성화 — 옛 캐시 정리
   ------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('walk-nav-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------
   전략 1) 네트워크 우선 — 우리 앱 파일용
   온라인이면 항상 최신, 오프라인이면 캐시
   ------------------------------------------------------------ */
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    // no-store: 브라우저 HTTP 캐시까지 건너뛰고 진짜 최신본을 받음
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      return (await cache.match('./index.html')) ||
             (await cache.match('./')) ||
             Response.error();
    }
    return Response.error();
  }
}

/* ------------------------------------------------------------
   전략 2) 캐시 우선 — 지도 타일 / 외부 라이브러리용
   한 번 받은 지도는 계속 재사용 (데이터·배터리 절약, 오프라인 대비)
   ------------------------------------------------------------ */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    return Response.error();
  }
}

/* ------------------------------------------------------------
   요청 라우팅
   ------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 우리 앱 파일과 페이지 이동 → 네트워크 우선 (자동 업데이트)
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 지도 타일, unpkg CDN → 캐시 우선
  event.respondWith(cacheFirst(req));
});

/* ------------------------------------------------------------
   앱에서 "지금 바로 업데이트" 신호를 받으면 즉시 교체
   ------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
