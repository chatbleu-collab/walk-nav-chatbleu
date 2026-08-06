/* ============================================================
   걷기 내비 - 메인 스크립트
   ------------------------------------------------------------
   개인정보 원칙: 위치·경로·걸음수 등 모든 데이터는
   이 브라우저 안(IndexedDB)에만 저장되며 외부로 전송되지 않습니다.
   네트워크로 나가는 요청은 지도 이미지(타일)를 받아오는 것뿐입니다.
   ============================================================ */

'use strict';

/* ============================================================
   0. 공통 유틸리티
   ============================================================ */

const $ = (id) => document.getElementById(id);

/** 지구 반지름 (미터) */
const EARTH_R = 6371008.8;

/**
 * 두 위경도 좌표 사이의 거리 (미터) — 하버사인 공식
 */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 좌표 배열의 총 길이 (미터)
 * pts: [[lat, lng], ...]
 */
function pathLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  }
  return total;
}

/**
 * 한 점에서 선분(경로)까지의 최단 거리 (미터).
 * 짧은 거리에서는 위경도를 평면으로 근사해도 오차가 무시할 수준입니다.
 */
function distanceToPath(lat, lng, pts) {
  if (!pts || pts.length === 0) return Infinity;
  if (pts.length === 1) return haversine(lat, lng, pts[0][0], pts[0][1]);

  const toRad = Math.PI / 180;
  const latScale = EARTH_R * toRad;                       // 위도 1도당 미터
  const lngScale = EARTH_R * toRad * Math.cos(lat * toRad); // 경도 1도당 미터

  const px = lng * lngScale;
  const py = lat * latScale;

  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][1] * lngScale, ay = pts[i - 1][0] * latScale;
    const bx = pts[i][1] * lngScale,     by = pts[i][0] * latScale;

    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let t = 0;
    if (len2 > 0) {
      t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return best;
}

/** 초 → "MM:SS" 또는 "H:MM:SS" */
function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 페이스(1km당 걸리는 시간) → "5'30"" */
function formatPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return `--'--"`;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}

/** 화면 하단 알림 */
let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), ms);
}


/**
 * 경로 단순화 — Douglas-Peucker 알고리즘
 * ------------------------------------------------------------
 * GPS 기록기는 1~5m마다 점을 찍기 때문에 5km 코스가 3천 개 점이 되곤 합니다.
 * 모양은 그대로 두고 점 개수만 줄여서 앱이 느려지지 않게 합니다.
 * tolMeters: 이 거리 안쪽으로 벗어나는 점은 없애도 된다고 판단
 */
function simplifyPath(pts, tolMeters) {
  const n = pts.length;
  if (n <= 2 || tolMeters <= 0) return pts.slice();

  // 짧은 범위에서는 위경도를 평면 좌표(미터)로 근사해도 됩니다.
  const toRad = Math.PI / 180;
  const lat0 = pts[0][0];
  const kx = EARTH_R * toRad * Math.cos(lat0 * toRad); // 경도 1도 → 미터
  const ky = EARTH_R * toRad;                          // 위도 1도 → 미터
  const P = pts.map((p) => [p[1] * kx, p[0] * ky]);

  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;

  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    if (e - s < 2) continue;

    const ax = P[s][0], ay = P[s][1];
    const bx = P[e][0], by = P[e][1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = P[i][0], py = P[i][1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }

    if (maxD > tolMeters && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }

  return pts.filter((_, i) => keep[i]);
}


/* ============================================================
   1-A. GPX 파일 읽기 / 만들기
   ------------------------------------------------------------
   전부 브라우저 안에서 처리합니다. 파일이 폰 밖으로 나가지 않습니다.
   ============================================================ */

const GPX = (() => {

  /**
   * 네임스페이스에 상관없이 태그를 찾습니다.
   * (GPX 파일마다 <trkpt> 또는 <gpx:trkpt> 로 제각각이라서)
   */
  function findTags(root, tagName) {
    let list = root.getElementsByTagNameNS('*', tagName);
    if (list.length === 0) list = root.getElementsByTagName(tagName);
    return Array.from(list);
  }

  /**
   * GPX 텍스트 → { name, points, kind, original }
   * 실패하면 Error를 던집니다.
   */
  // 단순화 허용 오차 (미터).
  // 코스 이탈 경고 기준이 기본 50m이므로, 그보다 훨씬 작아야
  // 단순화 때문에 엉뚱한 이탈 경고가 뜨지 않습니다.
  // 도시에서 나란히 붙은 두 골목(약 15~20m 간격)도 구분되는 값입니다.
  function parse(text, tolMeters = 8) {
    if (!text || !text.trim()) {
      throw new Error('파일이 비어 있습니다.');
    }
    // BOM 제거 (윈도우에서 만든 파일 대응)
    text = text.replace(/^﻿/, '').trim();

    if (text.indexOf('<gpx') === -1 && text.indexOf(':gpx') === -1) {
      throw new Error('GPX 파일이 아닙니다. 확장자가 .gpx 인 파일을 선택해 주세요.');
    }

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('파일이 손상되었거나 형식이 올바르지 않습니다.');
    }

    const root = doc.documentElement;
    if (!root) throw new Error('파일을 읽을 수 없습니다.');

    // 좌표를 담고 있는 태그를 우선순위대로 찾습니다.
    //   trkpt : 실제로 걸은 궤적 (가장 흔함)
    //   rtept : 미리 계획한 경로
    //   wpt   : 개별 지점만 찍어놓은 경우
    let nodes = findTags(root, 'trkpt');
    let kind = '트랙';
    if (nodes.length === 0) { nodes = findTags(root, 'rtept'); kind = '경로'; }
    if (nodes.length === 0) { nodes = findTags(root, 'wpt');   kind = '지점'; }

    if (nodes.length === 0) {
      throw new Error('파일 안에 좌표가 없습니다.');
    }

    const raw = [];
    for (const nd of nodes) {
      const lat = parseFloat(nd.getAttribute('lat'));
      const lon = parseFloat(nd.getAttribute('lon'));
      // 값이 이상한 점은 건너뜁니다.
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      if (lat === 0 && lon === 0) continue; // 흔한 오류값
      raw.push([lat, lon]);
    }

    if (raw.length < 2) {
      throw new Error('쓸 수 있는 좌표가 2개 미만입니다.');
    }

    // 코스 이름 찾기 (트랙 이름 → 메타데이터 이름 순)
    let name = '';
    const trks = findTags(root, 'trk');
    if (trks.length) {
      const n = findTags(trks[0], 'name')[0];
      if (n) name = (n.textContent || '').trim();
    }
    if (!name) {
      const meta = findTags(root, 'metadata')[0];
      if (meta) {
        const n = findTags(meta, 'name')[0];
        if (n) name = (n.textContent || '').trim();
      }
    }
    if (!name) {
      const rtes = findTags(root, 'rte');
      if (rtes.length) {
        const n = findTags(rtes[0], 'name')[0];
        if (n) name = (n.textContent || '').trim();
      }
    }
    name = name.slice(0, 30);

    // ── 점 개수 줄이기 ──
    // GPS 기록기가 만든 촘촘한 트랙만 줄입니다.
    // 손으로 찍은 경로(rtept)나 지점(wpt), 점이 적은 파일은
    // 하나하나가 의도적으로 찍은 것이므로 절대 건드리지 않습니다.
    const DENSE_THRESHOLD = 100;
    const shouldSimplify = (kind === '트랙') && (raw.length > DENSE_THRESHOLD);
    const points = shouldSimplify ? simplifyPath(raw, tolMeters) : raw;

    return {
      name,
      points,
      kind,
      originalCount: raw.length,
      originalDistance: pathLength(raw)
    };
  }

  /** XML에 그대로 넣으면 안 되는 문자 처리 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /**
   * 좌표 배열 → GPX 텍스트
   * asTrack=true 면 <trk>(걸은 기록), false 면 <rte>(계획 코스)
   */
  function build(name, points, { asTrack = false, startTime = null } = {}) {
    const tag = asTrack ? 'trkpt' : 'rtept';
    const body = points.map(([lat, lng]) =>
      `      <${tag} lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"></${tag}>`
    ).join('\n');

    const meta = startTime
      ? `  <metadata>\n    <name>${esc(name)}</name>\n    <time>${new Date(startTime).toISOString()}</time>\n  </metadata>\n`
      : `  <metadata>\n    <name>${esc(name)}</name>\n  </metadata>\n`;

    const inner = asTrack
      ? `  <trk>\n    <name>${esc(name)}</name>\n    <trkseg>\n${body}\n    </trkseg>\n  </trk>\n`
      : `  <rte>\n    <name>${esc(name)}</name>\n${body}\n  </rte>\n`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="걷기 내비" xmlns="http://www.topografix.com/GPX/1/1">
${meta}${inner}</gpx>
`;
  }

  /**
   * 파일로 저장.
   * 새 탭을 열지 않고 다운로드만 발생시킵니다.
   */
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_self';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1200);
  }

  /** 파일명으로 못 쓰는 문자 정리 */
  function safeName(s) {
    return String(s || '코스').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  }

  return { parse, build, download, safeName };
})();


/* ============================================================
   1. 저장소 (IndexedDB)
   ============================================================ */

const DB = (() => {
  const NAME = 'walk-nav-db';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('courses')) {
          db.createObjectStore('courses', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('walks')) {
          db.createObjectStore('walks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      try { result = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    put:    (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
    del:    (store, key)   => tx(store, 'readwrite', (s) => s.delete(key)),
    all:    (store)        => tx(store, 'readonly',  (s) => s.getAll()),
    get:    (store, key)   => tx(store, 'readonly',  (s) => s.get(key))
  };
})();

/** 설정값 저장/복원 (간단히 localStorage 사용) */
const Prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('wn_' + key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem('wn_' + key, String(val)); } catch (e) {}
  }
};


/* ============================================================
   2. 음성 안내 (Web Speech API)
   ============================================================ */

const Voice = (() => {
  let unlocked = false;
  let koVoice = null;

  /** iOS는 사용자가 버튼을 누른 순간에 한 번 speak()를 호출해줘야 이후 재생이 허용됩니다. */
  function unlock() {
    if (unlocked || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
      unlocked = true;
    } catch (e) {}
    pickVoice();
  }

  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const list = speechSynthesis.getVoices() || [];
    koVoice = list.find((v) => v.lang === 'ko-KR') ||
              list.find((v) => v.lang && v.lang.toLowerCase().startsWith('ko')) ||
              null;
  }

  if ('speechSynthesis' in window) {
    speechSynthesis.addEventListener('voiceschanged', pickVoice);
  }

  function speak(text, { interrupt = false } = {}) {
    if (!('speechSynthesis' in window) || !text) return;
    try {
      if (interrupt) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (koVoice) u.voice = koVoice;
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  return { unlock, speak };
})();


/* ============================================================
   3. 화면 켜짐 유지 (Wake Lock)
   ============================================================ */

const Wake = (() => {
  let lock = null;

  async function on() {
    if (!('wakeLock' in navigator)) return false;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function off() {
    try { if (lock) await lock.release(); } catch (e) {}
    lock = null;
  }

  /** 다른 앱 갔다 돌아오면 잠금이 풀려 있으므로 다시 잡습니다. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Tracker.isRunning() && !lock) {
      on();
    }
  });

  return { on, off, active: () => !!lock };
})();


/* ============================================================
   4. 걸음수 측정 (가속도 센서)
   ------------------------------------------------------------
   센서를 쓸 수 없으면 "이동거리 ÷ 보폭"으로 자동 대체합니다.
   ============================================================ */

const Pedometer = (() => {
  let steps = 0;
  let running = false;
  let usingSensor = false;

  // 피크 검출용 상태
  let smoothed = 0;          // 저역통과 필터를 거친 가속도 크기
  let lastStepAt = 0;        // 마지막 걸음 시각
  let risingAbove = false;   // 임계선 위로 올라간 상태인지
  let dynMin = 9.8, dynMax = 9.8;

  const MIN_STEP_GAP = 260;  // ms — 분당 최대 약 230보
  const MAX_STEP_GAP = 2200; // ms — 이보다 오래 멈추면 상태 초기화
  const MIN_AMPLITUDE = 1.1; // m/s² — 이보다 흔들림이 작으면 걸음으로 안 봄

  function onMotion(e) {
    if (!running) return;
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null) return;

    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

    // 저역통과 필터로 잔떨림 제거
    smoothed = smoothed === 0 ? mag : smoothed * 0.78 + mag * 0.22;

    // 최근 진폭 추적 (서서히 수렴시켜 자세 변화에 적응)
    dynMax = Math.max(smoothed, dynMax * 0.98 + smoothed * 0.02);
    dynMin = Math.min(smoothed, dynMin * 0.98 + smoothed * 0.02);

    const amplitude = dynMax - dynMin;
    const threshold = (dynMax + dynMin) / 2;
    const now = Date.now();

    if (now - lastStepAt > MAX_STEP_GAP) risingAbove = false;

    if (amplitude < MIN_AMPLITUDE) return; // 거의 정지 상태

    if (!risingAbove && smoothed > threshold + amplitude * 0.12) {
      risingAbove = true;
    } else if (risingAbove && smoothed < threshold - amplitude * 0.12) {
      risingAbove = false;
      if (now - lastStepAt >= MIN_STEP_GAP) {
        steps++;
        lastStepAt = now;
      }
    }
  }

  /** iOS 13+ 는 사용자 제스처 안에서 권한을 요청해야 합니다. */
  async function requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        return res === 'granted';
      } catch (e) {
        return false;
      }
    }
    return true; // 안드로이드 등은 권한 요청 절차가 없음
  }

  async function start() {
    steps = 0;
    smoothed = 0;
    dynMin = 9.8; dynMax = 9.8;
    risingAbove = false;
    lastStepAt = 0;
    running = true;

    const ok = await requestPermission();
    if (ok && 'ondevicemotion' in window) {
      window.addEventListener('devicemotion', onMotion);
      usingSensor = true;
    } else {
      usingSensor = false;
    }
    return usingSensor;
  }

  function stop() {
    running = false;
    window.removeEventListener('devicemotion', onMotion);
  }

  function pause() { running = false; }
  function resume() { running = true; }

  /**
   * 걸음수 반환.
   * 센서를 못 쓰면 이동거리를 보폭으로 나눠 추정합니다.
   */
  function count(distanceMeters, strideMeters) {
    if (usingSensor && steps > 0) return steps;
    return Math.round(distanceMeters / Math.max(0.3, strideMeters));
  }

  return { start, stop, pause, resume, count, usingSensor: () => usingSensor };
})();


/* ============================================================
   5. 지도 & 코스 만들기
   ============================================================ */

const CourseMap = (() => {
  let map = null;
  let polyline = null;
  let markers = [];
  let meMarker = null;
  let points = [];       // [[lat, lng], ...]
  let loadedCourseId = null;

  function init() {
    const saved = Prefs.get('lastCenter', '');
    let center = [37.5665, 126.9780]; // 기본값: 서울시청
    let zoom = 15;
    if (saved) {
      const p = saved.split(',').map(Number);
      if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) center = p;
    }

    map = L.map('map', {
      center,
      zoom,
      zoomControl: false,
      attributionControl: true
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap 기여자'
    }).addTo(map);

    polyline = L.polyline([], {
      color: '#4ade80',
      weight: 5,
      opacity: 0.9
    }).addTo(map);

    map.on('click', (e) => addPoint(e.latlng.lat, e.latlng.lng));

    map.on('moveend', () => {
      const c = map.getCenter();
      Prefs.set('lastCenter', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
    });

    // 지도 컨테이너 크기가 나중에 잡히는 경우 대비
    setTimeout(() => map.invalidateSize(), 300);
  }

  // 점이 이보다 많으면(GPX로 불러온 경우) 시작·도착만 표시합니다.
  // 수백 개 마커를 그리면 지도가 버벅이기 때문입니다.
  const MAX_MARKERS = 40;

  function makeDot(p, label) {
    return L.circleMarker([p[0], p[1]], {
      radius: 6,
      color: '#ffffff',
      weight: 2,
      fillColor: '#22c55e',
      fillOpacity: 1
    }).addTo(map).bindTooltip(String(label), { permanent: false });
  }

  function redrawMarkers() {
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (points.length === 0) return;

    if (points.length <= MAX_MARKERS) {
      points.forEach((p, i) => markers.push(makeDot(p, i + 1)));
    } else {
      markers.push(makeDot(points[0], '시작'));
      markers.push(makeDot(points[points.length - 1], '도착'));
    }
  }

  function addPoint(lat, lng) {
    points.push([lat, lng]);
    polyline.setLatLngs(points);
    redrawMarkers();
    loadedCourseId = null;
    render();
  }

  function undo() {
    if (points.length === 0) return;
    points.pop();
    polyline.setLatLngs(points);
    redrawMarkers();
    render();
  }

  function clear() {
    points = [];
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    polyline.setLatLngs([]);
    loadedCourseId = null;
    $('courseName').value = '';
    $('gpxNote').textContent = '';
    $('gpxNote').className = 'gpx-note';
    render();
  }

  /** 좌표 배열을 한 번에 올립니다 (GPX 불러오기, 저장된 코스 열기) */
  function setPoints(pts, name) {
    points = pts.slice();
    polyline.setLatLngs(points);
    redrawMarkers();
    loadedCourseId = null;
    if (name) $('courseName').value = name;
    if (points.length > 1) {
      map.fitBounds(polyline.getBounds(), { padding: [30, 30] });
    } else if (points.length === 1) {
      map.setView(points[0], 16);
    }
    render();
  }

  function load(course) {
    clear();
    setPoints(course.points, course.name);
    loadedCourseId = course.id;
  }

  function render() {
    const meters = pathLength(points);
    $('planDistance').textContent = (meters / 1000).toFixed(2);
    $('planPoints').textContent = points.length;
    // 평균 보행속도 4.5 km/h 기준 예상 시간
    $('planEta').textContent = Math.round(meters / 1000 / 4.5 * 60);

    $('planHint').textContent = points.length === 0
      ? '지도를 탭해서 걸을 코스의 지점을 순서대로 찍으세요.'
      : '지점을 계속 추가하거나, 이름을 넣고 저장하세요.';
  }

  /** 현재 위치로 지도 이동 */
  function locate() {
    if (!navigator.geolocation) {
      toast('이 브라우저는 위치 기능을 지원하지 않습니다.');
      return;
    }
    toast('위치를 찾는 중…', 1500);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 17);
        showMe(latitude, longitude);
      },
      (err) => {
        toast(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  function showMe(lat, lng) {
    if (!map) return;
    if (!meMarker) {
      meMarker = L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] })
      }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lng]);
    }
  }

  return {
    init, undo, clear, load, locate, showMe, setPoints,
    getPoints: () => points.slice(),
    getMap: () => map,
    invalidate: () => { if (map) map.invalidateSize(); }
  };
})();

function geoErrorMessage(err) {
  switch (err && err.code) {
    case 1: return '위치 권한이 거부되었습니다. 브라우저 설정에서 허용해 주세요.';
    case 2: return '위치를 확인할 수 없습니다. 하늘이 트인 곳에서 다시 시도해 보세요.';
    case 3: return '위치 확인이 너무 오래 걸립니다. 다시 시도해 주세요.';
    default: return '위치를 가져오지 못했습니다.';
  }
}


/* ============================================================
   6. 걷기 추적 (GPS)
   ============================================================ */

const Tracker = (() => {
  let watchId = null;
  let running = false;
  let paused = false;

  let startedAt = 0;
  let pausedTotal = 0;    // 일시정지로 흘려보낸 시간(ms)
  let pausedAt = 0;

  let distance = 0;       // 누적 이동거리 (미터)
  let path = [];          // 실제 걸은 경로
  let last = null;        // { lat, lng, t }

  let tickTimer = null;
  let nextVoiceAt = 0;    // 다음 음성 안내 거리 (미터)

  // 코스 이탈 상태
  let lastDeviateWarn = 0;
  let lastOffDistance = 0;
  let wasOffCourse = false;

  let courseRef = null;   // 따라 걷는 코스의 좌표 배열

  // --- GPS 노이즈 필터 기준 ---
  const MAX_ACCURACY = 35;   // m — 오차가 이보다 크면 무시
  const MIN_MOVE = 1.5;      // m — 이보다 작으면 제자리 떨림으로 간주
  const MAX_SPEED = 6.0;     // m/s (약 21 km/h) — 이보다 빠르면 GPS 튐

  function settings() {
    return {
      voiceEvery: Number($('setVoiceEvery').value),
      stride: Number($('setStride').value),
      weight: Number($('setWeight').value),
      deviate: Number($('setDeviate').value)
    };
  }

  function elapsedSec() {
    if (!startedAt) return 0;
    const now = paused ? pausedAt : Date.now();
    return (now - startedAt - pausedTotal) / 1000;
  }

  function kcal() {
    const s = settings();
    const hours = elapsedSec() / 3600;
    if (hours <= 0) return 0;
    const kmh = (distance / 1000) / hours;
    let met = 3.5;
    if (kmh < 3.2) met = 2.8;
    else if (kmh < 4.8) met = 3.5;
    else if (kmh < 5.6) met = 4.3;
    else if (kmh < 6.4) met = 5.0;
    else met = 7.0;
    return met * s.weight * hours;
  }

  function setGpsStatus(kind, text) {
    const dot = $('gpsDot');
    dot.className = 'dot' + (kind ? ' ' + kind : '');
    $('gpsText').textContent = text;
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const t = pos.timestamp || Date.now();

    CourseMap.showMe(lat, lng);

    if (accuracy > MAX_ACCURACY) {
      setGpsStatus('weak', `GPS 신호 약함 (오차 ${Math.round(accuracy)}m)`);
      return;
    }
    setGpsStatus('good', `GPS 양호 (오차 ${Math.round(accuracy)}m)` +
      (Pedometer.usingSensor() ? ' · 센서 걸음수' : ' · 거리 기반 걸음수'));

    if (paused) { last = { lat, lng, t }; return; }

    if (last) {
      const d = haversine(last.lat, last.lng, lat, lng);
      const dt = Math.max(0.001, (t - last.t) / 1000);
      const speed = d / dt;

      if (d >= MIN_MOVE && speed <= MAX_SPEED) {
        distance += d;
        path.push([lat, lng]);
        last = { lat, lng, t };
        checkVoice();
      } else if (speed > MAX_SPEED) {
        // GPS가 튄 것으로 보고 기준점만 갱신
        last = { lat, lng, t };
      }
    } else {
      last = { lat, lng, t };
      path.push([lat, lng]);
    }

    // 코스 이탈 검사는 이동 여부와 무관하게 매번 실행합니다.
    // (길을 잘못 들어 제자리에 서 있을 때야말로 경고가 필요하므로)
    checkDeviation(lat, lng);

    updateUI();
  }

  /** 일정 거리마다 음성 안내 */
  function checkVoice() {
    const s = settings();
    if (!s.voiceEvery) return;
    if (distance < nextVoiceAt) return;

    const km = distance / 1000;
    const sec = elapsedSec();
    const steps = Pedometer.count(distance, s.stride);

    const kmText = km >= 1
      ? `${km.toFixed(1)} 킬로미터`
      : `${Math.round(distance)} 미터`;
    const minText = `${Math.round(sec / 60)}분`;

    Voice.speak(`${kmText} 지났습니다. ${minText} 걸었고, 총 ${steps.toLocaleString('ko-KR')} 걸음입니다.`);

    nextVoiceAt = Math.floor(distance / s.voiceEvery) * s.voiceEvery + s.voiceEvery;
  }

  /**
   * 코스 이탈 경고
   * - 기준을 넘는 순간 즉시 1회 경고 (GPS 신호가 오는 1~3초 안)
   * - 계속 이탈 중이면 반복 경고. 점점 더 멀어지면 간격을 좁혀 더 자주 알림
   * - 기준의 70% 안쪽으로 돌아오면 "복귀" 안내 (경계선에서 껐다 켜졌다 하는 것 방지)
   */
  function checkDeviation(lat, lng) {
    const s = settings();
    if (!s.deviate || !courseRef || courseRef.length < 2) return;

    const off = distanceToPath(lat, lng, courseRef);
    const now = Date.now();

    // --- 코스로 복귀 ---
    if (off <= s.deviate * 0.7) {
      if (wasOffCourse) {
        wasOffCourse = false;
        lastDeviateWarn = 0;
        Voice.speak('코스로 돌아왔습니다.', { interrupt: true });
        toast('코스 복귀');
        if (navigator.vibrate) navigator.vibrate(60);
      }
      lastOffDistance = off;
      return;
    }

    // --- 경계선 안쪽 (아직 이탈 아님) ---
    if (off <= s.deviate) {
      lastOffDistance = off;
      return;
    }

    // --- 이탈 상태 ---
    const gettingWorse = off > lastOffDistance + 15;   // 15m 이상 더 멀어졌는가
    const interval = gettingWorse ? 15000 : 40000;      // 멀어지는 중이면 15초마다

    if (!wasOffCourse || now - lastDeviateWarn > interval) {
      wasOffCourse = true;
      lastDeviateWarn = now;
      Voice.speak(`코스에서 ${Math.round(off)} 미터 벗어났습니다.`, { interrupt: true });
      toast(`코스 이탈 — 약 ${Math.round(off)}m`);
      if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
    }
    lastOffDistance = off;
  }

  function onError(err) {
    setGpsStatus('bad', geoErrorMessage(err));
  }

  function updateUI() {
    const s = settings();
    const km = distance / 1000;
    const sec = elapsedSec();
    const steps = Pedometer.count(distance, s.stride);

    $('wDistance').textContent = km.toFixed(2);
    $('wTime').textContent = formatTime(sec);
    $('wSteps').textContent = steps.toLocaleString('ko-KR');
    $('wPace').textContent = km > 0.02 ? formatPace(sec / km) : `--'--"`;
    $('wKcal').textContent = Math.round(kcal());

    // 주머니 모드 화면도 갱신
    $('pDistance').textContent = km.toFixed(2) + ' km';
    $('pTime').textContent = formatTime(sec);
  }

  async function start(coursePoints) {
    if (!navigator.geolocation) {
      toast('이 브라우저는 위치 기능을 지원하지 않습니다.');
      return false;
    }

    // 사용자 제스처 안에서 음성/센서 권한을 확보
    Voice.unlock();
    const sensorOk = await Pedometer.start();

    running = true;
    paused = false;
    startedAt = Date.now();
    pausedTotal = 0;
    pausedAt = 0;
    distance = 0;
    path = [];
    last = null;
    lastDeviateWarn = 0;
    lastOffDistance = 0;
    wasOffCourse = false;
    courseRef = (coursePoints && coursePoints.length >= 2) ? coursePoints : null;

    const s = settings();
    nextVoiceAt = s.voiceEvery || Infinity;

    setGpsStatus('', 'GPS 연결 중…');

    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 1000
    });

    tickTimer = setInterval(updateUI, 1000);

    await Wake.on();

    const intro = courseRef
      ? `코스를 따라 걷기를 시작합니다. 총 ${(pathLength(courseRef) / 1000).toFixed(1)} 킬로미터입니다.`
      : '걷기를 시작합니다.';
    Voice.speak(intro);

    if (!sensorOk) {
      toast('걸음수는 이동거리로 계산합니다 (센서 미사용).', 3400);
    }
    return true;
  }

  function togglePause() {
    if (!running) return;
    if (!paused) {
      paused = true;
      pausedAt = Date.now();
      Pedometer.pause();
      Voice.speak('일시정지합니다.', { interrupt: true });
      setGpsStatus('weak', '일시정지 중');
    } else {
      paused = false;
      pausedTotal += Date.now() - pausedAt;
      pausedAt = 0;
      Pedometer.resume();
      Voice.speak('다시 시작합니다.', { interrupt: true });
    }
    updateUI();
    return paused;
  }

  async function stop() {
    if (!running) return null;

    const s = settings();
    const sec = elapsedSec();
    const steps = Pedometer.count(distance, s.stride);
    const cal = Math.round(kcal());

    running = false;
    paused = false;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    clearInterval(tickTimer); tickTimer = null;
    Pedometer.stop();
    await Wake.off();

    setGpsStatus('', 'GPS 대기 중');

    const record = {
      id: 'w' + Date.now(),
      date: new Date().toISOString(),
      distance: Math.round(distance),
      duration: Math.round(sec),
      steps,
      kcal: cal,
      path: path.slice()
    };

    // 너무 짧은 기록(50m 미만)은 저장하지 않음
    if (record.distance >= 50) {
      await DB.put('walks', record);
    }

    Voice.speak(
      `걷기를 마쳤습니다. 총 ${(distance / 1000).toFixed(1)} 킬로미터, ` +
      `${Math.round(sec / 60)}분, ${steps.toLocaleString('ko-KR')} 걸음입니다.`,
      { interrupt: true }
    );

    return record;
  }

  return {
    start, stop, togglePause, updateUI,
    isRunning: () => running,
    isPaused: () => paused,
    reset() {
      distance = 0; path = []; last = null;
      startedAt = 0; pausedTotal = 0; pausedAt = 0;
      updateUI();
    }
  };
})();


/* ============================================================
   7. 주머니 모드 (화면 잠금)
   ============================================================ */

const Pocket = (() => {
  let holdTimer = null;

  function on() {
    $('pocket').classList.add('is-on');
    Tracker.updateUI();
    toast('화면 잠금 · 길게 눌러 해제', 2000);
  }

  function off() {
    $('pocket').classList.remove('is-on');
  }

  function bind() {
    const el = $('pocket');

    const startHold = (e) => {
      e.preventDefault();
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        off();
        if (navigator.vibrate) navigator.vibrate(45);
      }, 1600); // 1.6초 길게 누르면 해제
    };
    const cancelHold = () => clearTimeout(holdTimer);

    el.addEventListener('touchstart', startHold, { passive: false });
    el.addEventListener('touchend', cancelHold);
    el.addEventListener('touchcancel', cancelHold);
    el.addEventListener('touchmove', cancelHold);
    el.addEventListener('mousedown', startHold);
    el.addEventListener('mouseup', cancelHold);
    el.addEventListener('mouseleave', cancelHold);
  }

  return { on, off, bind };
})();


/* ============================================================
   8. 목록 렌더링 (코스 / 기록)
   ============================================================ */

async function renderCourses() {
  const courses = (await DB.all('courses')) || [];
  courses.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const ul = $('courseList');
  const sel = $('walkCourse');

  // 코스 목록
  if (courses.length === 0) {
    ul.innerHTML = '<li class="empty">아직 저장된 코스가 없습니다.</li>';
  } else {
    ul.innerHTML = '';
    courses.forEach((c) => {
      const li = document.createElement('li');

      const main = document.createElement('div');
      main.className = 'ci-main';
      const name = document.createElement('div');
      name.className = 'ci-name';
      name.textContent = c.name;
      const sub = document.createElement('div');
      sub.className = 'ci-sub';
      sub.textContent = `${(c.distance / 1000).toFixed(2)} km · 지점 ${c.points.length}개`;
      main.appendChild(name);
      main.appendChild(sub);

      const bLoad = document.createElement('button');
      bLoad.className = 'ci-btn';
      bLoad.type = 'button';
      bLoad.textContent = '열기';
      bLoad.addEventListener('click', () => {
        CourseMap.load(c);
        toast(`"${c.name}" 코스를 불러왔습니다.`);
      });

      const bDel = document.createElement('button');
      bDel.className = 'ci-btn danger';
      bDel.type = 'button';
      bDel.textContent = '삭제';
      bDel.addEventListener('click', async () => {
        if (!confirm(`"${c.name}" 코스를 삭제할까요?`)) return;
        await DB.del('courses', c.id);
        await renderCourses();
        toast('삭제했습니다.');
      });

      li.appendChild(main);
      li.appendChild(bLoad);
      li.appendChild(bDel);
      ul.appendChild(li);
    });
  }

  // 걷기 화면의 코스 선택 드롭다운
  const prev = sel.value;
  sel.innerHTML = '<option value="">— 코스 없이 자유롭게 걷기 —</option>';
  courses.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} (${(c.distance / 1000).toFixed(2)} km)`;
    sel.appendChild(o);
  });
  if (prev) sel.value = prev;
}

async function renderHistory() {
  const walks = (await DB.all('walks')) || [];
  walks.sort((a, b) => new Date(b.date) - new Date(a.date));

  const totalKm = walks.reduce((s, w) => s + w.distance, 0) / 1000;
  const totalSteps = walks.reduce((s, w) => s + w.steps, 0);
  $('sumCount').textContent = walks.length;
  $('sumKm').textContent = totalKm.toFixed(1);
  $('sumSteps').textContent = totalSteps.toLocaleString('ko-KR');

  const ul = $('historyList');
  if (walks.length === 0) {
    ul.innerHTML = '<li class="empty">아직 기록이 없습니다.</li>';
    return;
  }

  ul.innerHTML = '';
  walks.forEach((w) => {
    const li = document.createElement('li');
    const d = new Date(w.date);
    const dateStr = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ` +
                    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const main = document.createElement('div');
    main.className = 'ci-main';
    const name = document.createElement('div');
    name.className = 'ci-name';
    name.textContent = `${(w.distance / 1000).toFixed(2)} km · ${formatTime(w.duration)}`;
    const sub = document.createElement('div');
    sub.className = 'ci-sub';
    sub.textContent = `${dateStr} · ${w.steps.toLocaleString('ko-KR')}걸음 · ${w.kcal}kcal`;
    main.appendChild(name);
    main.appendChild(sub);

    // 걸은 경로를 GPX 파일로 저장
    const bGpx = document.createElement('button');
    bGpx.className = 'ci-btn';
    bGpx.type = 'button';
    bGpx.textContent = 'GPX';
    bGpx.addEventListener('click', () => {
      if (!w.path || w.path.length < 2) {
        toast('저장된 경로가 없는 기록입니다.');
        return;
      }
      const label = `걷기 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      GPX.download(
        GPX.safeName(label) + '.gpx',
        GPX.build(label, w.path, { asTrack: true, startTime: w.date })
      );
      toast('GPX 파일로 저장했습니다.');
    });

    const bDel = document.createElement('button');
    bDel.className = 'ci-btn danger';
    bDel.type = 'button';
    bDel.textContent = '삭제';
    bDel.addEventListener('click', async () => {
      if (!confirm('이 기록을 삭제할까요?')) return;
      await DB.del('walks', w.id);
      await renderHistory();
    });

    li.appendChild(main);
    li.appendChild(bGpx);
    li.appendChild(bDel);
    ul.appendChild(li);
  });
}


/* ============================================================
   9. 화면 전환 & 이벤트 연결
   ============================================================ */

/* ------------------------------------------------------------
   GPX 파일 처리
   ------------------------------------------------------------ */

function gpxNote(msg, kind) {
  const el = $('gpxNote');
  el.textContent = msg || '';
  el.className = 'gpx-note' + (kind ? ' ' + kind : '');
}

/** 파일 하나를 읽어 코스로 올립니다. */
function handleGpxFile(file) {
  // 사진 등을 잘못 고른 경우를 먼저 걸러냅니다.
  if (file.size > 20 * 1024 * 1024) {
    gpxNote('파일이 너무 큽니다 (20MB 초과).', 'err');
    return;
  }
  if (file.type && file.type.startsWith('image/')) {
    gpxNote('사진 파일입니다. .gpx 파일을 선택해 주세요.', 'err');
    return;
  }

  gpxNote('파일을 읽는 중…');

  const reader = new FileReader();

  reader.onerror = () => {
    gpxNote('파일을 읽지 못했습니다. 다시 시도해 주세요.', 'err');
  };

  reader.onload = () => {
    let data;
    try {
      data = GPX.parse(String(reader.result));
    } catch (err) {
      gpxNote(err.message, 'err');
      return;
    }

    // 이름이 파일에 없으면 파일명에서 가져옵니다.
    const fallbackName = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
    const name = data.name || fallbackName || 'GPX 코스';

    CourseMap.setPoints(data.points, name);

    const km = (pathLength(data.points) / 1000).toFixed(2);
    let msg = `${data.kind} 불러옴 — ${km} km, 지점 ${data.points.length}개`;
    if (data.originalCount > data.points.length) {
      const diff = Math.abs(data.originalDistance - pathLength(data.points));
      msg += ` (원본 ${data.originalCount.toLocaleString('ko-KR')}개에서 간략화, 거리 차이 ${Math.round(diff)}m)`;
    }
    gpxNote(msg, 'ok');
    toast(`"${name}" 불러오기 완료`);
  };

  // GPX는 UTF-8 텍스트입니다.
  reader.readAsText(file, 'UTF-8');
}


function switchView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
  $('view-' + name).classList.add('is-active');
  document.querySelector(`.tab[data-view="${name}"]`).classList.add('is-active');

  if (name === 'plan') setTimeout(() => CourseMap.invalidate(), 100);
  if (name === 'history') renderHistory();
}

function bindUI() {
  // 탭
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      if (Tracker.isRunning() && t.dataset.view !== 'walk') {
        toast('걷는 중에는 다른 화면으로 이동할 수 없습니다.');
        return;
      }
      switchView(t.dataset.view);
    });
  });

  // 지도 도구
  $('btnLocate').addEventListener('click', () => CourseMap.locate());
  $('btnUndo').addEventListener('click', () => CourseMap.undo());
  $('btnClear').addEventListener('click', () => {
    if (CourseMap.getPoints().length === 0) return;
    if (confirm('그린 코스를 모두 지울까요?')) CourseMap.clear();
  });

  // ---------- GPX 불러오기 ----------
  const gpxInput = $('gpxFile');

  $('btnImportGpx').addEventListener('click', () => {
    gpxInput.value = '';   // 같은 파일을 다시 골라도 이벤트가 뜨도록
    gpxInput.click();
  });

  gpxInput.addEventListener('change', () => {
    const f = gpxInput.files && gpxInput.files[0];
    if (f) handleGpxFile(f);
  });

  // 데스크톱에서 파일을 끌어다 놓기
  ['dragenter', 'dragover'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      document.body.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      if (ev === 'drop') e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      document.body.classList.remove('dragging');
    });
  });
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleGpxFile(f);
  });

  // ---------- GPX 내보내기 (현재 그린 코스) ----------
  $('btnExportCourse').addEventListener('click', () => {
    const pts = CourseMap.getPoints();
    if (pts.length < 2) {
      gpxNote('내보낼 코스가 없습니다. 지점을 2개 이상 찍거나 코스를 불러오세요.', 'err');
      return;
    }
    const name = $('courseName').value.trim() || '걷기 코스';
    try {
      GPX.download(GPX.safeName(name) + '.gpx', GPX.build(name, pts, { asTrack: false }));
      gpxNote(`"${name}" 을(를) GPX 파일로 저장했습니다.`, 'ok');
    } catch (e) {
      gpxNote('파일을 저장하지 못했습니다: ' + e.message, 'err');
    }
  });

  // 코스 저장
  $('btnSaveCourse').addEventListener('click', async () => {
    const pts = CourseMap.getPoints();
    if (pts.length < 2) {
      toast('지점을 2개 이상 찍어 주세요.');
      return;
    }
    let name = $('courseName').value.trim();
    if (!name) name = `코스 ${new Date().toLocaleDateString('ko-KR')}`;

    await DB.put('courses', {
      id: 'c' + Date.now(),
      name,
      points: pts,
      distance: Math.round(pathLength(pts)),
      createdAt: Date.now()
    });
    await renderCourses();
    toast(`"${name}" 저장 완료`);
  });

  // 걷기 시작
  $('btnStart').addEventListener('click', async () => {
    let coursePoints = null;
    const cid = $('walkCourse').value;
    if (cid) {
      const c = await DB.get('courses', cid);
      if (c) coursePoints = c.points;
    }

    const ok = await Tracker.start(coursePoints);
    if (!ok) return;

    $('btnStart').classList.add('hidden');
    $('btnPause').classList.remove('hidden');
    $('btnStop').classList.remove('hidden');
    $('btnPocket').classList.remove('hidden');
    $('walkCourse').disabled = true;
  });

  // 일시정지 / 재개
  $('btnPause').addEventListener('click', () => {
    const paused = Tracker.togglePause();
    $('btnPause').textContent = paused ? '계속 걷기' : '일시정지';
  });

  // 종료
  $('btnStop').addEventListener('click', async () => {
    if (!confirm('걷기를 종료할까요?')) return;

    const rec = await Tracker.stop();

    $('btnStart').classList.remove('hidden');
    $('btnPause').classList.add('hidden');
    $('btnPause').textContent = '일시정지';
    $('btnStop').classList.add('hidden');
    $('btnPocket').classList.add('hidden');
    $('walkCourse').disabled = false;
    Pocket.off();

    if (rec && rec.distance >= 50) {
      toast(`기록 저장 완료 — ${(rec.distance / 1000).toFixed(2)} km`);
      await renderHistory();
    } else {
      toast('이동거리가 너무 짧아 저장하지 않았습니다.');
    }
    Tracker.reset();
  });

  // 주머니 모드
  $('btnPocket').addEventListener('click', () => Pocket.on());
  Pocket.bind();

  // 설정 저장/복원
  ['setVoiceEvery', 'setStride', 'setWeight', 'setDeviate'].forEach((id) => {
    const el = $(id);
    const saved = Prefs.get(id, null);
    if (saved !== null) el.value = saved;
    el.addEventListener('change', () => Prefs.set(id, el.value));
  });

  // 걷는 중에 실수로 앱을 닫는 것 방지
  window.addEventListener('beforeunload', (e) => {
    if (Tracker.isRunning()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}


/* ============================================================
   10. 시작
   ============================================================ */

function boot() {
  // Leaflet 로딩 확인
  if (typeof L === 'undefined') {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:20px;color:#f87171;font-size:14px;line-height:1.6">' +
      '지도 라이브러리를 불러오지 못했습니다.<br>인터넷에 연결한 뒤 앱을 한 번 실행하면, ' +
      '이후에는 오프라인에서도 사용할 수 있습니다.</div>');
    return;
  }

  CourseMap.init();
  bindUI();
  renderCourses();
  renderHistory();

  setupServiceWorker();
}

/* ------------------------------------------------------------
   서비스워커 등록 + 자동 업데이트
   ------------------------------------------------------------
   GitHub에 새 파일을 올리면:
   1) 앱을 켤 때마다 새 버전이 있는지 조용히 확인
   2) 있으면 화면 아래에 "업데이트 있음 — 탭하면 적용" 알림
   3) 탭하면 즉시 교체 후 새로고침
   걷는 중에는 기록이 끊기지 않도록 알림을 띄우지 않고 미룹니다.
   ------------------------------------------------------------ */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;
  let pendingWorker = null;

  // 새 서비스워커가 제어권을 잡으면 화면 새로고침
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  function offerUpdate(worker) {
    pendingWorker = worker;
    // 걷는 중이면 방해하지 않음 — 종료 후 다시 켤 때 적용됩니다.
    if (Tracker.isRunning()) return;

    const el = $('toast');
    el.textContent = '새 버전이 있습니다 — 탭하면 업데이트';
    el.classList.add('is-on');
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';

    const apply = () => {
      el.removeEventListener('click', apply);
      el.style.pointerEvents = 'none';
      el.textContent = '업데이트 적용 중…';
      if (pendingWorker) pendingWorker.postMessage({ type: 'SKIP_WAITING' });
    };
    el.addEventListener('click', apply);

    // 12초 뒤 자동으로 숨김 (다음 실행 때 다시 안내됨)
    setTimeout(() => {
      el.classList.remove('is-on');
      el.style.pointerEvents = 'none';
      el.style.cursor = '';
    }, 12000);
  }

  window.addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('./sw.js');
    } catch (e) {
      // file:// 로 직접 열었거나 HTTPS가 아니면 등록이 안 됩니다.
      // 앱 기능 자체에는 지장이 없습니다.
      return;
    }

    // 이미 대기 중인 새 버전이 있으면 바로 안내
    if (reg.waiting && navigator.serviceWorker.controller) {
      offerUpdate(reg.waiting);
    }

    // 새 버전이 설치되는 중이면 완료될 때 안내
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(nw);
        }
      });
    });

    // 앱으로 돌아올 때마다 업데이트 확인 (최소 30분 간격)
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheck < 30 * 60 * 1000) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
