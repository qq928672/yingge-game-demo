
// 只在本機測試環境顯示測試用功能（例如重置站點進度），正式上線的網址不會出現
const IS_LOCAL_DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

// ---------- Backend API ----------
// 混合架構：報名/商店/兌換品項目錄這些低頻、由 Google Sheets 管理的資料還是走 GAS；
// 登入、答題、過關判定、點數兌換/核銷這些活動當天會被大量同時呼叫的動作，
// 改走 Cloudflare Workers + D1（並發撐得比 GAS 高很多），靠 action 名稱分流。
const API_URL = "https://script.google.com/macros/s/AKfycbytcB8w4wDFOK32d8g4FrcEiK3TQNDj0Ob8aFPINFo5t7c_jqMDfzBgnVcyailEjpPMeg/exec";
const WORKER_API_URL = "https://yingge-game-api.ntcecea.workers.dev";
const WORKER_ACTIONS = new Set(["login", "state", "submitAnswer", "complete", "purchase", "redeemItem", "googleLogin", "resetProgress", "clearInventory"]);

// Google 帳號登入用——要跟 worker/src/index.js 裡的 GOOGLE_CLIENT_ID 是同一組，
// 從 Google Cloud Console 申請 OAuth 用戶端 ID 後填進來
const GOOGLE_CLIENT_ID = "423812002134-e7iebeorhcjvqk173tt559ngd59cfipl.apps.googleusercontent.com";

// 地圖圖磚：透過 Worker 的 /tile 路由轉發（OSM 官方的 tile.openstreetmap.org 只供輕量測試，正式流量
// 會被擋，之前上線後地圖直接被 OSM 回 403 就是這個原因）。實際的 Thunderforest API Key 藏在 Worker
// 那端（secret THUNDERFOREST_KEY），不會出現在前端原始碼裡，也順便讓 Worker 邊緣快取圖磚降低用量。
const TILE_URL = WORKER_API_URL + "/tile/{z}/{x}/{y}.png";

// 現場網路常常不穩、後端偶爾會逾時，所以連線失敗時自動重試幾次再放棄，
// 減少玩家自己手動按「再試一次」的機會（伺服器回傳的業務錯誤，例如序號錯誤，
// 屬於正常回應不會走到這裡，只有 fetch 本身失敗或回應不是合法 JSON 才會重試）
async function fetchJsonWithRetry(doFetch, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch();
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function apiGet(params) {
  const base = WORKER_ACTIONS.has(params.action) ? WORKER_API_URL : API_URL;
  const url = base + "?" + new URLSearchParams(params).toString();
  return fetchJsonWithRetry(() => fetch(url));
}

// purchase 不是冪等操作（每次呼叫都會真的 INSERT 一筆 inventory、扣一次點數），如果請求已經
// 送達伺服器並成功寫入，只是回應封包在傳回來的路上遺失，自動重試會讓同一筆兌換被真的執行兩次、
// 玩家被多扣點數——所以這個 action 不能套用自動重試，連線失敗就直接讓玩家看到錯誤、自己決定要不要再按一次
const NON_IDEMPOTENT_ACTIONS = new Set(["purchase"]);

async function apiPost(body) {
  if (WORKER_ACTIONS.has(body.action)) {
    const attempts = NON_IDEMPOTENT_ACTIONS.has(body.action) ? 1 : 3;
    return fetchJsonWithRetry(() => fetch(WORKER_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify(body),
    }), attempts);
  }
  // 用 text/plain 避免瀏覽器對 Apps Script 發出 CORS 預檢請求（Apps Script 不處理 OPTIONS）
  return fetchJsonWithRetry(() => fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  }));
}

// 目前在地圖上瀏覽/遊玩的路線（鶯歌／三峽），純前端顯示用的篩選狀態，跟哪個序號登入無關，
// 所以存在 localStorage 就好，換裝置或清快取只會回到預設的「鶯歌」，不影響任何伺服器端資料
let state = {
  code: null, progress: {}, name: "", balance: 0, balanceByRoute: {}, inventory: [],
  isTester: false, ageCategory: "一般民眾",
  route: localStorage.getItem("yingge_route") || "鶯歌",
};

// 目前路線底下的站點清單——地圖、集章本都改看這份清單，而不是整個 STATIONS
function routeStations() {
  return STATIONS.filter(s => s.route === state.route);
}

// 畫面上顯示的站點編號（NO.01、地圖圖釘上的數字…）要在各自路線裡從 1 開始算，
// 不能直接顯示 st.id——st.id 是全部路線共用的全域編號（三峽從 11 開始接續鶯歌），
// 只用在跟後端溝通/存進度用，畫面上一律換算成「這個站點在自己路線裡排第幾個」
function stationDisplayNo(st) {
  const idx = STATIONS.filter(s => s.route === st.route).findIndex(s => s.id === st.id);
  return idx + 1;
}

// 是否顯示模擬定位等測試工具：本機測試環境一律顯示；正式網址只有 Worker 判定為測試帳號
// （TESTER_EMAILS 白名單，見 worker/src/index.js）的登入者才會是 true
function shouldShowDebugTools() {
  return IS_LOCAL_DEV || !!state.isTester;
}

// ---------- Text-to-speech (accessibility for players who have trouble reading) ----------
// Android Chrome loads its voice list asynchronously — calling speak() before that finishes
// silently produces no sound at all (no error). We warm the list up on load and, if it's
// still empty when speak() is first called, wait once for "voiceschanged" before speaking.

let ttsVoices = [];
if ("speechSynthesis" in window) {
  const loadVoices = () => { ttsVoices = window.speechSynthesis.getVoices(); };
  loadVoices();
  window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

function pickChineseVoice() {
  if (!ttsVoices.length) return null;
  return (
    ttsVoices.find(v => v.lang === "zh-TW") ||
    ttsVoices.find(v => /zh[-_](TW|Hant)/i.test(v.lang)) ||
    ttsVoices.find(v => v.lang === "zh-CN") ||
    ttsVoices.find(v => /^zh/i.test(v.lang)) ||
    null
  );
}

function speakNow(text) {
  window.speechSynthesis.cancel(); // stop any speech already in progress before starting new
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "zh-TW";
  utter.rate = 0.95;
  const voice = pickChineseVoice();
  if (voice) utter.voice = voice;
  utter.onerror = (e) => console.warn("TTS failed:", e.error);
  window.speechSynthesis.speak(utter);
}

let lastSpeakAt = 0;

function speak(text) {
  if (!("speechSynthesis" in window) || !text) return;
  // ignore rapid repeated taps on the speak button — besides being pointless (it just
  // restarts the same line), spamming speak() in quick succession is what seems to trigger
  // Android's "Google - tap to see search results" overlay on some devices
  const now = Date.now();
  if (now - lastSpeakAt < 600) return;
  lastSpeakAt = now;
  if (!ttsVoices.length) {
    // voice list not ready yet (common on first use in Android Chrome) — wait once, then speak
    let spoken = false;
    const trySpeak = () => {
      if (spoken) return;
      spoken = true;
      ttsVoices = window.speechSynthesis.getVoices();
      speakNow(text);
    };
    window.speechSynthesis.addEventListener("voiceschanged", trySpeak, { once: true });
    // some browsers never fire voiceschanged if there's truly nothing new to load — try anyway after a short delay
    setTimeout(trySpeak, 300);
    return;
  }
  speakNow(text);
}

// 用 Google 帳號登入：表單本來就設定「自動收集信箱」，代表報名時填表人已經是登入 Google 帳號的狀態，
// 所以直接讓玩家用 Google 帳號登入、拿已驗證過的信箱去比對報名名單，就不用再另外產生序號、寄信通知，
// 序號查登入還是保留在下面當備用方式（例如玩家换了 Google 帳號、或現場沒帶信箱那組帳號登入等情況）
function initGoogleSignIn() {
  const btnEl = document.getElementById("google-signin-btn");
  if (!btnEl) return; // 這個畫面沒有 Google 登入按鈕（例如 demo 版有自己的登入方式），不用做任何事
  if (typeof google === "undefined" || !google.accounts) {
    setTimeout(initGoogleSignIn, 300); // GIS 的 script 是 async 載入，晚一點才會有 window.google，稍後重試
    return;
  }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
  google.accounts.id.renderButton(btnEl, {
    theme: "outline", size: "large", width: 280, text: "signin_with", shape: "pill",
  });
}

async function handleGoogleCredential(response) {
  const errEl = document.getElementById("login-error");
  errEl.textContent = "登入中...";
  try {
    const res = await apiPost({ action: "googleLogin", idToken: response.credential });
    if (!res.ok) {
      errEl.textContent = res.error || "登入失敗，請確認是否已完成報名表單";
      return;
    }
    errEl.textContent = "";
    state.code = res.code;
    loadPlayerIntoState(res);
    localStorage.setItem("yingge_last_code", res.code);
    resetIdleTimer();
    showMap();
  } catch (e) {
    errEl.textContent = "連線失敗，請檢查網路後再試一次";
  }
}

function loadPlayerIntoState(data) {
  state.name = data.name;
  state.progress = data.progress || {};
  // balanceByRoute 是每個路線各自獨立的餘額（例如 { 鶯歌: 3, 三峽: 0 }），state.balance
  // 則是「目前地圖上選的那條路線」對應的餘額，給既有的畫面（背包/交換所）直接讀
  if (data.balanceByRoute) state.balanceByRoute = data.balanceByRoute;
  if (state.balanceByRoute[state.route] != null) state.balance = state.balanceByRoute[state.route];
  else if (typeof data.balance === "number") state.balance = data.balance;
  if (data.inventory) state.inventory = data.inventory; // only login/purchase/redeem send this; complete doesn't touch it
  // 只有 login/googleLogin 的回應會帶這兩個欄位；complete 等其他動作沒帶，不能因此當成
  // false／預設值，把已經確認過的測試帳號身分或年齡別洗掉
  if (typeof data.isTester === "boolean") state.isTester = data.isTester;
  if (data.ageCategory) state.ageCategory = data.ageCategory;
}

function logout() {
  const keepRoute = state.route;
  state = {
    code: null, progress: {}, name: "", balance: 0, balanceByRoute: {}, inventory: [],
    isTester: false, ageCategory: "一般民眾", route: keepRoute,
  };
  localStorage.removeItem("yingge_last_code");
  localStorage.removeItem("yingge_pending_arrival");
  document.getElementById("login-error").textContent = "";
  document.getElementById("login-card").style.display = "";
  document.getElementById("login-restoring").style.display = "none";
  showScreen("screen-login");
  stopIdleTimer();
}

// 測試帳號專用：把自己序號在伺服器上的過關/答題/兌換紀錄整個清空，方便反覆重玩測試整趟流程。
// 跟 devResetStation() 不一樣——那個只清本機畫面顯示、不動伺服器資料；這個是真的呼叫 Worker
// 清空 D1 裡的紀錄，所以不只本機端環境能用，正式網址用測試帳號登入也看得到這顆按鈕。
async function resetMyProgress() {
  if (!state.code) return;
  if (!confirm("確定要重置目前這組序號的所有進度嗎？\n（過關紀錄、答題紀錄、兌換紀錄都會被清空，這個動作無法復原）")) return;
  try {
    const res = await apiPost({ action: "resetProgress", code: state.code });
    if (!res.ok) { alert(res.error || "重置失敗，請稍後再試"); return; }
    loadPlayerIntoState(res);
    localStorage.removeItem("yingge_pending_arrival");
    renderMap();
    alert("已重置完成！");
  } catch (e) {
    alert("連線失敗，請檢查網路後再試一次");
  }
}

// 測試帳號專用：只清空背包（兌換紀錄），過關進度/答題紀錄不會被動到——方便反覆測試
// 「購買→背包→核銷」這段流程，不用每次都重新破關賺獎章
async function clearMyInventory() {
  if (!state.code) return;
  if (!confirm("確定要清空背包嗎？\n（只會清掉兌換紀錄，過關進度不會被動到，這個動作無法復原）")) return;
  try {
    const res = await apiPost({ action: "clearInventory", code: state.code });
    if (!res.ok) { alert(res.error || "清除失敗，請稍後再試"); return; }
    loadPlayerIntoState(res);
    renderBackpack();
    alert("背包已清空！");
  } catch (e) {
    alert("連線失敗，請檢查網路後再試一次");
  }
}

// ---------- Idle auto-logout: stay signed in indefinitely, but log out after 15 minutes with no interaction ----------
const IDLE_LIMIT_MS = 15 * 60 * 1000;
let idleTimer = null;

function resetIdleTimer() {
  if (!state.code) return; // only relevant once logged in
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.code) logout();
  }, IDLE_LIMIT_MS);
}

function stopIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

["click", "touchstart", "keydown", "scroll"].forEach(evt =>
  window.addEventListener(evt, resetIdleTimer, { passive: true })
);

// screens that live behind the bottom tab bar — any other screen hides it
const TAB_SCREENS = { "screen-map": "map", "screen-stamps": "stamps", "screen-rewards": "rewards", "screen-backpack": "backpack" };

function showScreen(id) {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel(); // don't let TTS keep talking after the player navigates away
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
  const tabbar = document.getElementById("tabbar");
  const tabKey = TAB_SCREENS[id];
  tabbar.classList.toggle("visible", !!tabKey);
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.screen === tabKey));
}

function completedCount() {
  return routeStations().filter(st => state.progress[st.id]).length;
}

// 切換地圖上目前瀏覽的路線（鶯歌／三峽）。只是前端顯示篩選，不用重新打 API——
// 該路線的餘額已經在登入時透過 balanceByRoute 一起拿回來了。
function setRoute(routeId) {
  if (state.route === routeId) return;
  state.route = routeId;
  localStorage.setItem("yingge_route", routeId);
  state.balance = state.balanceByRoute[routeId] || 0;
  const balNumEl = document.getElementById("shop-balance-num");
  if (balNumEl) balNumEl.textContent = state.balance;
  rebuildStationMapForRoute();
  renderMap();
}

// 只給測試帳號／本機開發環境看到的路線（例如 public:false 的三峽，內容還沒確認完不開放給一般玩家），
// 跟 shouldShowDebugTools() 用同一套判斷（TESTER_EMAILS 白名單），路線準備好開放時把 public 拿掉就好
function visibleRoutes() {
  return ROUTES.filter(r => r.public !== false || shouldShowDebugTools());
}

function renderRouteSwitcher() {
  const el = document.getElementById("routeSwitcher");
  if (!el) return;
  const routes = visibleRoutes();
  // 只有一條路線看得到時，不需要顯示切換鈕（沒有其他路線可以切）
  if (routes.length < 2) { el.innerHTML = ""; return; }
  el.innerHTML = routes.map(r => `
    <div class="route-chip${r.id === state.route ? " active" : ""}" onclick="setRoute('${escapeAttr(r.id)}')">${r.name}</div>
  `).join("");
}

function showMap() {
  showScreen("screen-map");
  renderMap();
}

function openStampBook() {
  showScreen("screen-stamps");
  renderStampBook();
}

const STATION_SYMBOLS = { 1: "行", 2: "陶", 3: "石", 4: "瓷", 5: "爐", 6: "繪", 7: "榕", 8: "文", 9: "廟", 10: "街" };

function renderStampBook() {
  const stations = routeStations();
  const done = completedCount();
  const total = stations.length;
  document.getElementById("stampCount").innerHTML = done + "<small>／" + total + "</small>";
  document.getElementById("stampReward").textContent = done < total ? "每完成一站可得 1 枚獎章，快去交換所看看" : "全部蓋滿了，獎章都已入袋！";
  const stampGridEl = document.getElementById("stampGrid");
  stampGridEl.innerHTML = "";
  stations.forEach(st => {
    const slot = document.createElement("div");
    slot.className = "stamp-slot " + (state.progress[st.id] ? "filled" : "empty");
    slot.textContent = STATION_SYMBOLS[st.id] || String(stationDisplayNo(st)).padStart(2, "0");
    stampGridEl.appendChild(slot);
  });

  const grid = document.getElementById("station-grid");
  grid.innerHTML = "";
  stations.forEach(st => {
    const done = !!state.progress[st.id];
    const name = st.name.replace(/^站點[一二三四五六七八九十]+/, "");

    const card = document.createElement("div");
    card.className = "collect-card" + (done ? " done" : "");
    card.onclick = () => openStation(st.id);

    const statusLine = done
      ? `<div class="card-status">✓ 已收藏</div>`
      : `<div class="card-status">尚未解鎖</div>`;

    const posOverride = st.bgPosition ? `background-position:${st.bgPosition};` : "";
    const imageLayer = st.background
      ? `<div class="card-img${done ? "" : " grayscale"}" style="background-image:url('${encodeURI(st.background)}');${posOverride}"></div>`
      : `<div class="card-lock">${done ? "🖼️" : (st.icon || "🔒")}</div>`;

    card.innerHTML = `
      ${imageLayer}
      ${done ? `<div class="card-badge">✓</div>` : ""}
      <div class="card-bottom">
        <div class="card-stamp">${stampSvg(st)}</div>
        <div class="card-notes">
          <div class="card-no">NO. ${String(stationDisplayNo(st)).padStart(2, "0")}</div>
          <div class="card-name">${name}</div>
          ${statusLine}
        </div>
      </div>
    `;

    grid.appendChild(card);
  });
}

// A hand-stamped-looking badge for each station: two off-register rings (like a real rubber
// stamp with imperfect registration) around the station number. No image generation involved —
// this is a CSS/SVG stand-in until real per-location artwork exists.
const STAMP_PALETTE = ["#7c9885", "#c98a5e", "#8a95a8", "#a8896f", "#7c9885"];
function stampSvg(st) {
  const no = stationDisplayNo(st);
  const c = STAMP_PALETTE[(no - 1) % STAMP_PALETTE.length];
  const num = String(no).padStart(2, "0");
  return `<svg viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="41" fill="none" stroke="${c}" stroke-width="2.5" opacity="0.9"/>
    <text x="50" y="63" text-anchor="middle" font-family="'Noto Serif TC', serif" font-weight="600" font-size="40" fill="${c}">${num}</text>
  </svg>`;
}

/* ---------- Interactive station map (Leaflet) — replaces the old card-list ---------- */
let stationMap = null;
const mapMarkers = {};
let mapMeMarker = null;
let lastNearestMapId = null;
const mapMeIcon = L.divIcon({ className: "", html: `<div class="me-dot"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });

function mapPinIcon(st, done, isNearest) {
  const cls = isNearest ? "nearest" : done ? "done" : "locked";
  const html = `<div class="map-pin-wrap ${cls}">
    <div class="map-pin-ring"></div>
    <div class="map-pin">${done ? "✓" : stationDisplayNo(st)}</div>
    <div class="map-pin-tail"></div>
  </div>`;
  return L.divIcon({ className: "", html, iconSize: [38, 48], iconAnchor: [19, 46] });
}

function initStationMap() {
  if (stationMap) return;
  const withLoc = routeStations().filter(s => s.location);
  const center = withLoc.length
    ? [withLoc.reduce((a, s) => a + s.location.lat, 0) / withLoc.length, withLoc.reduce((a, s) => a + s.location.lng, 0) / withLoc.length]
    : [24.9540, 121.3545];
  // 把地圖能拖曳/縮放的範圍鎖在鶯歌活動範圍附近，避免有人滑到國外去把圖磚用量燒光
  // （padded 30% 讓範圍邊緣還留一些餘裕，不會拖一下就卡住彈回來）
  const panBounds = withLoc.length ? L.latLngBounds(withLoc.map(s => [s.location.lat, s.location.lng])).pad(0.3) : null;
  stationMap = L.map("stationMap", {
    zoomControl: false,
    maxBounds: panBounds || undefined,
    maxBoundsViscosity: 1.0,
    minZoom: 14
  }).setView(center, 16);
  L.tileLayer(TILE_URL, {
    maxZoom: 19, attribution: "&copy; Thunderforest &copy; OpenStreetMap contributors"
  }).addTo(stationMap);
  withLoc.forEach(st => {
    const done = !!state.progress[st.id];
    mapMarkers[st.id] = L.marker([st.location.lat, st.location.lng], { icon: mapPinIcon(st, done, false) })
      .addTo(stationMap).on("click", () => openMapSheet(st, !!state.progress[st.id]));
  });
  setTimeout(locateForMap, 400);

  // 只有「畫面上完全看不到任何一個站點圖示」時才浮現復位按鈕，而且是滑動/縮放
  // 結束後才判斷（不是滑動途中），手指在地圖上操作時不會不小心先點到它；
  // recenterStationMap 自己觸發的位移用 recenterInProgress 擋掉，不會滑完又立刻跳出同一顆按鈕。
  // initStationMap() 只會執行一次（見上面的 guard），但玩家後續可能切換路線（鶯歌／三峽），
  // 所以這裡不能沿用建圖當下就固定住的 withLoc，每次都要重新抓「目前路線」的站點座標，
  // 不然切過路線之後，這顆按鈕就會拿舊路線的座標去判斷，導致該出現時不出現、不該出現時亂跳出來
  stationMap.on("moveend", () => {
    if (recenterInProgress) return;
    const bounds = stationMap.getBounds();
    const currentWithLoc = routeStations().filter(s => s.location);
    const anyStationVisible = currentWithLoc.some(st => bounds.contains([st.location.lat, st.location.lng]));
    document.getElementById("mapRecenterBtn").classList.toggle("show", !anyStationVisible);
  });
}

let recenterInProgress = false;

// 有人把地圖滑到很遠的地方找不回來，按這顆按鈕直接縮放回「看得到所有關卡圖示」的範圍
function recenterStationMap() {
  if (!stationMap) return;
  const withLoc = routeStations().filter(s => s.location);
  if (!withLoc.length) return;
  document.getElementById("mapRecenterBtn").classList.remove("show");
  recenterInProgress = true;
  const bounds = L.latLngBounds(withLoc.map(s => [s.location.lat, s.location.lng]));
  stationMap.flyToBounds(bounds, { padding: [48, 48], maxZoom: 17 });
  stationMap.once("moveend", () => { recenterInProgress = false; });
}

function updateMapMarkers() {
  Object.keys(mapMarkers).forEach(id => {
    const st = STATIONS.find(s => s.id === Number(id));
    if (!st) return;
    const done = !!state.progress[st.id];
    mapMarkers[id].setIcon(mapPinIcon(st, done, Number(id) === lastNearestMapId));
  });
}

// 切換路線時整個重建地圖上的站點圖示：清掉舊路線的 marker，換上新路線的站點，
// 順便把可拖曳範圍（maxBounds）跟視角一起換到新路線的地理範圍
function rebuildStationMapForRoute() {
  if (!stationMap) return;
  Object.values(mapMarkers).forEach(m => stationMap.removeLayer(m));
  Object.keys(mapMarkers).forEach(k => delete mapMarkers[k]);
  lastNearestMapId = null;
  document.getElementById("nearestChip").style.display = "none";
  const withLoc = routeStations().filter(s => s.location);
  withLoc.forEach(st => {
    mapMarkers[st.id] = L.marker([st.location.lat, st.location.lng], { icon: mapPinIcon(st, !!state.progress[st.id], false) })
      .addTo(stationMap).on("click", () => openMapSheet(st, !!state.progress[st.id]));
  });
  if (withLoc.length) {
    const bounds = L.latLngBounds(withLoc.map(s => [s.location.lat, s.location.lng]));
    stationMap.setMaxBounds(bounds.pad(0.3));
    stationMap.flyToBounds(bounds, { padding: [48, 48], maxZoom: 17 });
  }
}

let myLastLat = null, myLastLng = null;

function updateNearestOnMap(lat, lng) {
  myLastLat = lat; myLastLng = lng;
  const withLoc = routeStations().filter(s => s.location);
  let nearest = null, nearestDist = Infinity;
  withLoc.forEach(st => {
    const d = haversineMeters(lat, lng, st.location.lat, st.location.lng);
    if (d < nearestDist) { nearestDist = d; nearest = st; }
  });
  if (!nearest) return;
  document.getElementById("locateMeBtn").style.display = "none";
  lastNearestMapId = nearest.id;
  updateMapMarkers();
  if (!mapMeMarker) mapMeMarker = L.marker([lat, lng], { icon: mapMeIcon, zIndexOffset: 500 }).addTo(stationMap);
  else mapMeMarker.setLatLng([lat, lng]);
  const chip = document.getElementById("nearestChip");
  chip.style.display = "flex";
  document.getElementById("nearestName").textContent = nearest.name.replace(/^站點[一二三四五六七八九十]+\s*/, "");
  document.getElementById("nearestDist").textContent = nearestDist < 1000 ? Math.round(nearestDist) + " 公尺" : (nearestDist / 1000).toFixed(1) + " 公里";
  chip.onclick = () => openMapSheet(nearest, !!state.progress[nearest.id]);
}

// 用 watchPosition 持續追蹤，不是只在進地圖畫面那一刻抓一次位置就結束——
// 不然玩家頁面開著、人已經走到別的站點，地圖上的「離你最近」還是會停在剛進地圖時的舊位置不動。
// initStationMap() 本身只會跑一次（有 guard），所以這裡也只會建立一個 watch，不會重複疊加。
function locateForMap() {
  if (!navigator.geolocation) { document.getElementById("locateMeBtn").style.display = "block"; return; }
  navigator.geolocation.watchPosition(
    pos => updateNearestOnMap(pos.coords.latitude, pos.coords.longitude),
    () => { document.getElementById("locateMeBtn").style.display = "block"; }, // 定位被拒絕/逾時/失敗——顯示按鈕讓玩家自己重試，不要整個功能默默消失
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
  );
}

// 玩家點「開啟定位」按鈕時重新嘗試一次；如果剛剛是被拒絕權限，大部分瀏覽器不會重新彈出詢問視窗，
// 這種情況再次失敗一樣會顯示這顆按鈕，順便用 alert 提醒去手機設定裡手動打開定位權限
function retryLocateForMap() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => updateNearestOnMap(pos.coords.latitude, pos.coords.longitude),
    () => alert("還是無法取得定位，請確認手機的定位服務跟瀏覽器的定位權限都已經打開"),
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

// 測試用：只清掉本機記憶體裡的完成狀態，讓開發者能重新走一次某一站的 RPG 劇情，
// 不會呼叫後端、不會動到 Google 試算表的 Progress 分頁——重新整理或重新登入後仍會顯示已完成。
// 只在 IS_LOCAL_DEV 時顯示按鈕，正式上線的網址不會出現，不用手動移除。
let devResetTargetId = null;
function devResetStation() {
  if (devResetTargetId == null) return;
  const st = STATIONS.find(s => s.id === devResetTargetId);
  if (!confirm(`確定要重置「${st ? st.name.replace(/^站點[一二三四五六七八九十]+\s*/, "") : devResetTargetId}」的完成狀態嗎？\n（只影響這次瀏覽，不會刪除伺服器上的紀錄）`)) return;
  delete state.progress[devResetTargetId];
  if (loadRpgProgress(devResetTargetId)) clearRpgProgress();
  closeMapSheet();
  renderMap();
}

function openMapSheet(st, done) {
  devResetTargetId = st.id;
  document.getElementById("mapSheetDevReset").style.display = (IS_LOCAL_DEV && done) ? "block" : "none";
  document.getElementById("mapSheetNo").textContent = "NO. " + String(stationDisplayNo(st)).padStart(2, "0");
  document.getElementById("mapSheetName").textContent = st.name.replace(/^站點[一二三四五六七八九十]+\s*/, "");
  document.getElementById("mapSheetAddr").textContent = st.address ? "📍 " + st.address : "📍 位置資訊尚未提供";
  const distEl = document.getElementById("mapSheetDist");
  if (st.location && myLastLat !== null) {
    const d = haversineMeters(myLastLat, myLastLng, st.location.lat, st.location.lng);
    distEl.textContent = "距離你目前位置約 " + (d < 1000 ? Math.round(d) + " 公尺" : (d / 1000).toFixed(1) + " 公里");
    distEl.style.display = "block";
  } else {
    distEl.style.display = "none";
  }
  document.getElementById("mapSheetPhoto").style.backgroundImage = st.background ? `url('${encodeURI(st.background)}')` : "";
  const navBtn = document.getElementById("mapSheetNav");
  if (st.location) {
    navBtn.style.display = "block";
    navBtn.onclick = () => {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${st.location.lat},${st.location.lng}&travelmode=walking`;
      window.open(url, "_blank");
    };
  } else {
    navBtn.style.display = "none";
  }
  const statusEl = document.getElementById("mapSheetStatus");
  if (done) { statusEl.textContent = "✓ 已完成"; statusEl.className = "map-sheet-status done"; }
  else { statusEl.textContent = "尚未解鎖"; statusEl.className = "map-sheet-status locked"; }
  document.getElementById("mapSheetGo").textContent = done ? "已完成關卡" : "開始關卡";
  document.getElementById("mapSheetGo").onclick = done
    ? () => { showInfoModal("此關卡已破關，請前往其他關卡", { title: "已完成" }); }
    : () => { closeMapSheet(); openStation(st.id); };
  document.getElementById("mapSheet").classList.add("active");
  document.getElementById("mapSheetBackdrop").classList.add("active");
}
// 取代原生 alert()：玩家看得到的單則訊息，統一走這個跟其他彈窗一致的樣式。
// emoji 沒填就不顯示圖示，title 沒填就不顯示標題（純文字訊息）
function showInfoModal(text, opts) {
  const o = opts || {};
  const emojiEl = document.getElementById("info-modal-emoji");
  emojiEl.textContent = o.emoji || "";
  emojiEl.style.display = o.emoji ? "block" : "none";
  const titleEl = document.getElementById("info-modal-title");
  titleEl.textContent = o.title || "";
  titleEl.style.display = o.title ? "block" : "none";
  document.getElementById("info-modal-text").textContent = text;
  document.getElementById("info-overlay").classList.add("active");
}
function closeInfoModal() {
  document.getElementById("info-overlay").classList.remove("active");
}

function closeMapSheet() {
  document.getElementById("mapSheet").classList.remove("active");
  document.getElementById("mapSheetBackdrop").classList.remove("active");
}

function renderMap() {
  // 保險機制：如果目前選到的路線對這個玩家來說是不公開的（例如 localStorage 殘留了測試時
  // 切過的三峽，但這個瀏覽器/帳號不是測試身分），退回第一條公開路線，不會讓一般玩家卡在
  // 看不到切換鈕、卻困在一個看不見站點的路線上
  if (!visibleRoutes().some(r => r.id === state.route)) {
    state.route = (visibleRoutes()[0] || ROUTES[0]).id;
    localStorage.setItem("yingge_route", state.route);
  }
  renderRouteSwitcher();
  const routeCfg = ROUTES.find(r => r.id === state.route);
  document.getElementById("mapTitle").textContent = (routeCfg && routeCfg.mapTitle) || (state.route + "時光地圖");
  initStationMap();
  updateMapMarkers();
  if (stationMap) setTimeout(() => stationMap.invalidateSize(), 50);

  const total = routeStations().length;
  const done = completedCount();
  document.getElementById("done-count").textContent = done;
  document.getElementById("map-count-total").textContent = "/" + total;
  document.getElementById("mapUsername").textContent = state.name || "";
  document.getElementById("mapResetProgress").style.display = shouldShowDebugTools() ? "inline" : "none";

  let hint = "";
  if (!total) hint = "這條路線的站點還在準備中，敬請期待";
  else if (done < total) hint = "每完成一站即可獲得 1 枚獎章，快去獎章商城看看";
  else hint = "恭喜全部完成！";
  document.getElementById("reward-hint").textContent = hint;
}

// ---------- Ticket wallet ----------


// ---------- Rewards shop (token economy — merchants → items → purchase → backpack) ----------

// Placeholder icons (same line-icon language as the tab bar) for merchants/items that don't
// have a real photo yet — keyed by merchant id or name so it still matches after a rename.
const ICON_POTTERY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3c-.5 2-1 2.5-1 4.5C9 10 7 11 7 14.5S9 21 12 21s5-3 5-6.5-2-4.5-2-7c0-2-.5-2.5-1-4.5"/></svg>`;
const ICON_TEA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M9 3c0 1-1 1-1 2s1 1 1 2M13 3c0 1-1 1-1 2s1 1 1 2"/></svg>`;
const ICON_BREAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13c0-4.5 3.5-8 8-8s8 3.5 8 8-3 6-8 6-8-1.5-8-6z"/><path d="M9 10c.5 1 .5 2 0 3M13 9c.5 1.5.5 3 0 4.5"/></svg>`;
const ICON_GIFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M4 9h16M12 9v11"/><path d="M12 9c-1.5 0-3-1-3-2.5S10 4 12 6c0-2 1.5-3.5 3-2.5S13.5 9 12 9z"/></svg>`;
const ICON_BIKE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="17" r="3.2"/><circle cx="18" cy="17" r="3.2"/><path d="M6 17l4-8h4l3 8M10 9l2 4h5M9 5h3l1 2"/></svg>`;
const ICON_STORE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9l1-5h14l1 5"/><path d="M4 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0"/><path d="M5 9v10h14V9"/><path d="M10 19v-5h4v5"/></svg>`;
const MERCHANT_ICONS = {
  "yingshao": { icon: ICON_POTTERY, color: "var(--purple)" },
  "鶯燒陶藝工作室": { icon: ICON_POTTERY, color: "var(--purple)" },
  "oldstreet-tea": { icon: ICON_TEA, color: "var(--accent)" },
  "老街茶館": { icon: ICON_TEA, color: "var(--accent)" },
  "sanying-bakery": { icon: ICON_BREAD, color: "var(--clay)" },
  "三鶯窯烤麵包坊": { icon: ICON_BREAD, color: "var(--clay)" },
  "ceramic-souvenir": { icon: ICON_GIFT, color: "var(--yellow-dark)" },
  "陶瓷老街紀念品鋪": { icon: ICON_GIFT, color: "var(--yellow-dark)" },
  "riverside-bike": { icon: ICON_BIKE, color: "var(--done)" },
  "河濱單車租借站": { icon: ICON_BIKE, color: "var(--done)" },
};
// merchant/item rows carry the merchant's id in the catalog, but backpack rows only store its
// name (the Inventory sheet was written that way) — keying by both lets this work in either place
function thumbHtml(photo, merchantKey, cls) {
  if (photo) return `<div class="${cls}" style="background-image:url('${encodeURI(photo)}')"></div>`;
  const cfg = MERCHANT_ICONS[merchantKey] || null;
  const color = cfg ? cfg.color : "var(--sub)";
  const icon = cfg ? cfg.icon : ICON_STORE;
  return `<div class="${cls} icon-fallback" style="background:${color}">${icon}</div>`;
}

let rewardsCatalog = null; // cached after first fetch; the catalog itself doesn't need a login

// 河濱單車租借站先不上架，暫時在前端濾掉（後端 Google Sheets 那筆資料還在，這裡只是不顯示）
const HIDDEN_MERCHANT_IDS = new Set(["riverside-bike"]);

async function getRewardsCatalog() {
  if (rewardsCatalog) return rewardsCatalog;
  try {
    const res = await apiGet({ action: "rewards" });
    rewardsCatalog = res.ok ? (res.merchants || []).filter(m => !HIDDEN_MERCHANT_IDS.has(m.id)) : [];
  } catch (e) {
    rewardsCatalog = [];
  }
  return rewardsCatalog;
}

// 商家分類篩選 — "全部" 一律顯示，其餘只列出目錄裡實際有出現的分類，順序依 MERCHANT_CATEGORIES
const MERCHANT_CATEGORIES = ["手作體驗", "美食飲品", "伴手禮", "交通"];
let shopCategoryFilter = "全部";

async function openRewardsShop() {
  showScreen("screen-rewards");
  document.getElementById("shop-balance-num").textContent = state.balance;
  const list = document.getElementById("merchant-list");
  list.innerHTML = `<p class="shop-empty">載入中...</p>`;
  const catalog = await getRewardsCatalog();
  if (!catalog.length) {
    document.getElementById("shop-category-filter").innerHTML = "";
    list.innerHTML = `<p class="shop-empty">目前還沒有可兌換的好禮，請稍後再來看看</p>`;
    return;
  }
  renderCategoryFilter(catalog);
  renderMerchantList(catalog);
}

function renderCategoryFilter(catalog) {
  const present = new Set(catalog.map(m => m.category).filter(Boolean));
  const cats = ["全部", ...MERCHANT_CATEGORIES.filter(c => present.has(c))];
  const el = document.getElementById("shop-category-filter");
  el.innerHTML = cats.map(c =>
    `<div class="shop-category-chip${c === shopCategoryFilter ? " active" : ""}" onclick="selectShopCategory('${escapeAttr(c)}')">${c}</div>`
  ).join("");
}

function selectShopCategory(cat) {
  shopCategoryFilter = cat;
  const catalog = rewardsCatalog || [];
  renderCategoryFilter(catalog);
  renderMerchantList(catalog);
}

function renderMerchantList(catalog) {
  const list = document.getElementById("merchant-list");
  const filtered = shopCategoryFilter === "全部" ? catalog : catalog.filter(m => m.category === shopCategoryFilter);
  if (!filtered.length) {
    list.innerHTML = `<p class="shop-empty">這個分類目前還沒有商家</p>`;
    return;
  }
  list.innerHTML = filtered.map(m => `
    <div class="merchant-card" onclick="openMerchantDetail('${escapeAttr(m.id)}')">
      ${thumbHtml(m.photo, m.id, "merchant-thumb")}
      <div class="merchant-body">
        <div class="merchant-name">${m.name}</div>
        <div class="merchant-tagline">${m.tagline || ""}</div>
        <div class="merchant-count">共 ${m.items.length} 項好禮</div>
      </div>
    </div>
  `).join("");
}

function openShopOverlay(html) {
  document.getElementById("shop-overlay-card").innerHTML = html;
  document.getElementById("shop-overlay").classList.add("active");
}
function closeShopOverlay() {
  document.getElementById("shop-overlay").classList.remove("active");
}

async function openMerchantDetail(merchantId) {
  const catalog = await getRewardsCatalog();
  const m = catalog.find(x => x.id === merchantId);
  if (!m) return;
  openShopOverlay(`
    <div class="shop-card">
      <div class="shop-card-close" onclick="closeShopOverlay()">✕</div>
      ${thumbHtml(m.photo, m.id, "shop-card-photo")}
      <div class="shop-card-name">${m.name}</div>
      <div class="shop-card-tagline">${m.tagline || ""}</div>
      <div class="shop-card-intro">${m.intro || ""}</div>
      <div style="margin-top:16px;font-weight:700;font-size:13px;color:var(--ink);">可兌換項目</div>
      ${m.items.map(it => `
        <div class="shop-item-row" onclick="openItemDetail('${escapeAttr(m.id)}','${escapeAttr(it.id)}')">
          ${thumbHtml(it.photo, m.id, "shop-item-thumb")}
          <div>
            <div class="shop-item-name">${it.name}</div>
            <div class="shop-item-cost">🏅 ${it.cost} 枚</div>
          </div>
        </div>
      `).join("")}
    </div>
  `);
}

async function openItemDetail(merchantId, itemId) {
  const catalog = await getRewardsCatalog();
  const m = catalog.find(x => x.id === merchantId);
  const it = m && m.items.find(x => x.id === itemId);
  if (!it) return;
  // 測試帳號（state.isTester，由 Worker 登入回應判定）不受點數限制，按鈕不能被這裡的前端
  // 餘額判斷卡住——實際擋不擋得下來還是由 Worker 端的 handlePurchase 決定，這裡只是不要
  // 讓測試帳號連「按下去試試看」的機會都沒有
  const can = state.isTester || state.balance >= it.cost;
  const photos = (it.photos && it.photos.length) ? it.photos : (it.photo ? [{ src: it.photo, caption: "" }] : []);
  openShopOverlay(`
    <div class="shop-card">
      <div class="shop-card-close" onclick="closeShopOverlay()">✕</div>
      <div class="shop-item-back" onclick="openMerchantDetail('${escapeAttr(merchantId)}')">‹ 返回 ${m.name}</div>
      ${photoCarouselHtml(photos, merchantId)}
      <div class="shop-card-name">${it.name}</div>
      <div class="shop-item-desc">${it.desc || ""}</div>
      ${itemDetailNotesHtml(it)}
      <div class="shop-item-cost-big">🏅 ${it.cost} 枚${state.isTester ? "（測試帳號不受限）" : ""}</div>
      <button class="shop-buy-btn" ${can ? "" : "disabled"} onclick="buyItem('${escapeAttr(itemId)}', this)">${can ? "兌換，存入背包" : "獎章不足"}</button>
    </div>
  `);
  initShopCarousel(photos);
}

// 兌換品項除了基本說明外，還可能有：要先預約的表單連結、年齡別折抵不同的兌換說明、
// 使用期限、限購一次/需帶證件之類的其他備註——四個欄位都是選填，有填才顯示對應那一行
function itemDetailNotesHtml(it) {
  const rows = [];
  if (it.redeemNote) rows.push(`<div class="shop-item-note"><span class="shop-item-note-label">📋 兌換說明</span>${escapeHtmlText(it.redeemNote)}</div>`);
  if (it.validPeriod) rows.push(`<div class="shop-item-note"><span class="shop-item-note-label">⏳ 使用期限</span>${escapeHtmlText(it.validPeriod)}</div>`);
  if (it.otherNote) rows.push(`<div class="shop-item-note"><span class="shop-item-note-label">📌 其他備註</span>${escapeHtmlText(it.otherNote)}</div>`);
  if (it.formUrl) rows.push(`<a class="shop-item-form-link" href="${escapeAttr(it.formUrl)}" target="_blank" rel="noopener">📝 前往預約表單</a>`);
  return rows.length ? `<div class="shop-item-notes">${rows.join("")}</div>` : "";
}

// 商品照片輪播——只有一張圖時直接顯示（不用輪播的複雜度），兩張以上才會出現左右箭頭／圓點／可滑動
let shopCarouselPhotos = [];
let shopCarouselIndex = 0;

function photoCarouselHtml(photos, fallbackKey) {
  if (!photos.length) return thumbHtml(null, fallbackKey, "shop-card-photo");
  if (photos.length === 1) {
    return `
      ${thumbHtml(photos[0].src, fallbackKey, "shop-card-photo")}
      ${photos[0].caption ? `<div class="shop-photo-caption-static">${escapeHtmlText(photos[0].caption)}</div>` : ""}
    `;
  }
  const slides = photos.map(p => `<div class="shop-photo-slide" style="background-image:url('${encodeURI(p.src)}')"></div>`).join("");
  const dots = photos.map((_, i) => `<button type="button" class="shop-photo-dot${i === 0 ? " active" : ""}" onclick="event.stopPropagation(); shopCarouselJump(${i})"></button>`).join("");
  return `
    <div class="shop-photo-carousel" id="shopCarousel" data-count="${photos.length}">
      <div class="shop-photo-track" id="shopCarouselTrack">${slides}</div>
      <button type="button" class="shop-photo-arrow prev" onclick="event.stopPropagation(); shopCarouselGo(-1)">‹</button>
      <button type="button" class="shop-photo-arrow next" onclick="event.stopPropagation(); shopCarouselGo(1)">›</button>
      ${photos[0].caption ? `<div class="shop-photo-caption" id="shopCarouselCaption">${escapeHtmlText(photos[0].caption)}</div>` : `<div class="shop-photo-caption" id="shopCarouselCaption" style="display:none;"></div>`}
      <div class="shop-photo-dots" id="shopCarouselDots">${dots}</div>
    </div>
  `;
}

function initShopCarousel(photos) {
  shopCarouselPhotos = photos;
  shopCarouselIndex = 0;
  const el = document.getElementById("shopCarousel");
  if (!el) return;
  let startX = null;
  el.addEventListener("touchstart", e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener("touchend", e => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) shopCarouselGo(dx > 0 ? -1 : 1);
    startX = null;
  }, { passive: true });
}

function shopCarouselGo(dir) {
  const track = document.getElementById("shopCarouselTrack");
  const el = document.getElementById("shopCarousel");
  if (!track || !el) return;
  const count = Number(el.dataset.count);
  shopCarouselIndex = (shopCarouselIndex + dir + count) % count;
  track.style.transform = `translateX(-${shopCarouselIndex * 100}%)`;
  document.querySelectorAll("#shopCarouselDots .shop-photo-dot").forEach((d, i) => d.classList.toggle("active", i === shopCarouselIndex));
  const caption = (shopCarouselPhotos[shopCarouselIndex] && shopCarouselPhotos[shopCarouselIndex].caption) || "";
  const captionEl = document.getElementById("shopCarouselCaption");
  captionEl.textContent = caption;
  captionEl.style.display = caption ? "block" : "none";
}

function shopCarouselJump(i) {
  shopCarouselGo(i - shopCarouselIndex);
}

// 等後端回應期間鎖住按鈕，不然手速快一點連點兩下，會在第一筆請求回來、
// 餘額還沒更新之前就送出第二筆，變成買到兩件、點數卻只扣一次
let buyItemPending = false;

async function buyItem(itemId, btnEl) {
  if (buyItemPending) return;
  buyItemPending = true;
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = "處理中…"; }
  try {
    // 這裡只是先確認商品在目錄裡存在，給個快速的錯誤訊息；實際價格一律由伺服器端
    // 重新核對，前端算出來的價格/商品資訊不會被信任（也不會送出去）
    const catalog = await getRewardsCatalog();
    const exists = catalog.some(m => m.items.some(it => it.id === itemId));
    if (!exists) { alert("查無此商品"); return; }
    const res = await apiPost({ action: "purchase", code: state.code, itemId });
    if (!res.ok) { alert(res.error || "兌換失敗，請再試一次"); return; }
    if (res.balanceByRoute) {
      state.balanceByRoute = res.balanceByRoute;
      state.balance = state.balanceByRoute[state.route] || 0;
    }
    state.inventory = res.inventory || state.inventory;
    document.getElementById("shop-balance-num").textContent = state.balance;
    openShopOverlay(`
      <div class="shop-card">
        <div class="shop-success">
          <div class="emoji">🎒</div>
          <h3>已加入背包！</h3>
          <p>到現場消費時，出示背包內容給店家核銷即可使用</p>
          <button onclick="closeShopOverlay(); openBackpack();">前往背包查看</button>
        </div>
      </div>
    `);
  } catch (e) {
    alert("連線失敗，請檢查網路後再試一次");
  } finally {
    buyItemPending = false;
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = "兌換，存入背包"; }
  }
}

function openBackpack() {
  showScreen("screen-backpack");
  renderBackpack();
}

function renderBackpack() {
  document.getElementById("bagClearInventory").style.display = shouldShowDebugTools() ? "inline-block" : "none";
  const list = document.getElementById("bag-list");
  if (!state.inventory.length) {
    list.innerHTML = `<p class="shop-empty">背包目前是空的，去獎章商城逛逛吧！</p>`;
    return;
  }
  list.innerHTML = state.inventory.map(it => `
    <div class="bag-card${it.used ? " used" : ""}" onclick="openVoucherDetail(${it.row})">
      ${thumbHtml(it.photo, it.merchant, "bag-thumb")}
      <div class="bag-body">
        <div class="bag-merchant">${it.merchant}</div>
        <div class="bag-name">${it.name}</div>
        <div class="bag-status ${it.used ? "used" : "unused"}">${it.used ? "✓ 已核銷" : "尚未使用"}</div>
      </div>
    </div>
  `).join("");
}

// 兌換券本身的編號——直接沿用 inventory 這筆紀錄的 id（跟 redeemItem 核銷時認的是同一個
// 值），不用另外產生一組隨機碼、也不用改資料庫欄位，格式化成看起來像正式票券號碼而已
function voucherSerial(row) {
  return "NTC-VCH-" + String(row).padStart(6, "0");
}

function findCatalogItem(itemId) {
  for (const m of rewardsCatalog || []) {
    const found = (m.items || []).find(it => it.id === itemId);
    if (found) return found;
  }
  return null;
}

// 背包裡的每一項兌換券，點開後用跟「關於本遊戲」同一套車票樣式呈現完整資訊：
// 持有人姓名／序號／票券編號／發行單位／可用店家／使用期限／使用規則——
// 這是要出示給工作人員核銷、換取實體票券用的畫面，資訊要完整、好辨識
async function openVoucherDetail(invRow) {
  const it = state.inventory.find(x => x.row === invRow);
  if (!it) return;
  await getRewardsCatalog(); // 確保商城目錄已經載入，才能拿到使用期限／兌換說明
  const catalogItem = findCatalogItem(it.itemId);
  const validPeriod = (catalogItem && catalogItem.validPeriod) || "無使用期限限制";
  const rules = [];
  if (catalogItem && catalogItem.redeemNote) rules.push(catalogItem.redeemNote);
  if (catalogItem && catalogItem.otherNote) rules.push(catalogItem.otherNote);
  const rulesText = rules.length ? rules.join("；") : "僅限本人使用，核銷後無法退換，請妥善保管此虛擬券。";
  // 「這是青年/一般民眾名額裡第幾份被兌換的」——用持有人自己的 age_category 決定要對照
  // 青年名額還是一般民眾名額，有設名額就顯示成「5／200」，沒設就只顯示「第 5 份」。
  // it.seq 是 Worker 算好、已經照同一組年齡別排序過的名次，這裡不用自己重算
  const categoryLimit = catalogItem && (state.ageCategory === "青年" ? catalogItem.youthLimit : catalogItem.generalLimit);
  const issueNo = categoryLimit ? `${it.seq}／${categoryLimit}` : `第 ${it.seq} 份`;

  openShopOverlay(`
    <div class="ticket voucher-ticket">
      <div class="ticket-head">
        <div class="ticket-route">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fffaf0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="5" width="16" height="12" rx="3"/><path d="M4 12h16M8 17l-1.5 3M16 17l1.5 3"/><circle cx="8.5" cy="9" r="0.6" fill="#fffaf0"/><circle cx="15.5" cy="9" r="0.6" fill="#fffaf0"/>
          </svg>
          <span>鶯歌壯遊兌換券</span>
        </div>
        <div class="ticket-no">${voucherSerial(it.row)}</div>
      </div>
      <div class="ticket-body">
        <h3 class="about-title">${it.name}</h3>
        <div class="ticket-field"><div class="k">持有人</div><div class="v">${escapeHtmlText(state.name)}</div></div>
        <div class="ticket-field"><div class="k">序號</div><div class="v">${escapeHtmlText(state.code)}</div></div>
        <div class="ticket-field"><div class="k">發行單位</div><div class="v">新北鶯歌環境文教協會</div></div>
        <div class="ticket-field"><div class="k">可用店家</div><div class="v">${escapeHtmlText(it.merchant)}</div></div>
        <div class="ticket-field"><div class="k">發行編號</div><div class="v">${escapeHtmlText(issueNo)}</div></div>
        <div class="ticket-field"><div class="k">使用期限</div><div class="v">${escapeHtmlText(validPeriod)}</div></div>
      </div>
      <div class="ticket-desc-wrap">
        <p class="ticket-desc">${escapeHtmlText(rulesText)}</p>
      </div>
      <div class="ticket-perf"></div>
      <div class="ticket-stub">
        <div class="ticket-barcode"></div>
        <div class="bag-status ${it.used ? "used" : "unused"}">${it.used ? "✓ 已核銷" + (it.usedAt ? "（" + escapeHtmlText(it.usedAt) + "）" : "") : "尚未核銷"}</div>
        ${it.used
          ? `<div class="about-close" onclick="closeShopOverlay()">關閉</div>`
          : `<button onclick="closeShopOverlay(); openRedeemItem(${it.row});">出示給工作人員核銷</button>
             <div class="about-close" onclick="closeShopOverlay()" style="margin-top:6px;">關閉</div>`}
      </div>
    </div>
  `);
}

function openRedeemItem(invRow) {
  openShopOverlay(`
    <div class="shop-card">
      <div class="shop-card-close" onclick="closeShopOverlay()">✕</div>
      <div class="shop-card-name">核銷確認</div>
      <div class="shop-item-desc">請將手機交給店家人員，由店家輸入核銷代碼以確認使用</div>
      <input type="text" id="redeem-passcode" class="redeem-input" placeholder="工作人員通關密語">
      <div class="redeem-error" id="redeem-error"></div>
      <button class="shop-buy-btn" onclick="submitRedeemItem(${invRow})">確認核銷</button>
    </div>
  `);
}

async function submitRedeemItem(invRow) {
  const code = document.getElementById("redeem-passcode").value.trim();
  const errEl = document.getElementById("redeem-error");
  errEl.textContent = "";
  if (!code) return;
  try {
    const res = await apiPost({ action: "redeemItem", code: state.code, invRow, staffPasscode: code });
    if (!res.ok) { errEl.textContent = res.error || "核銷失敗，請再試一次"; return; }
    state.inventory = res.inventory || state.inventory;
    closeShopOverlay();
    renderBackpack();
  } catch (e) {
    errEl.textContent = "連線失敗，請再試一次";
  }
}

// ---------- Partner store directory (public — no login required) ----------

let storesReturnScreen = "screen-login";
let storesCache = null;

function openStores() {
  const current = document.querySelector(".screen.active");
  if (current) storesReturnScreen = current.id;
  showScreen("screen-stores");
  renderStores();
}

function closeStores() {
  showScreen(storesReturnScreen);
}

async function renderStores() {
  const list = document.getElementById("stores-list");
  if (storesCache) {
    list.innerHTML = storesCache.map(storeCardHTML).join("") || `<div class="stores-empty">目前尚未公布合作店家</div>`;
    return;
  }
  list.innerHTML = `<div class="stores-empty">載入中...</div>`;
  try {
    const res = await apiGet({ action: "stores" });
    if (!res.ok) {
      list.innerHTML = `<div class="stores-empty">${res.error || "載入失敗，請稍後再試"}</div>`;
      return;
    }
    storesCache = res.stores || [];
    list.innerHTML = storesCache.map(storeCardHTML).join("") || `<div class="stores-empty">目前尚未公布合作店家</div>`;
  } catch (e) {
    list.innerHTML = `<div class="stores-empty">連線失敗，請檢查網路後再試一次</div>`;
  }
}

function storeCardHTML(s) {
  const photo = s.photo
    ? `<div class="store-photo" style="background-image:url('${encodeURI(s.photo)}')"></div>`
    : "";
  const mapBtn = s.mapUrl
    ? `<a class="store-map-btn" href="${encodeURI(s.mapUrl)}" target="_blank" rel="noopener">📍 開啟地圖導航</a>`
    : "";
  return `
    <div class="store-card">
      ${photo}
      <div class="store-body">
        <div class="store-name">${s.name}</div>
        ${s.offer ? `<div class="store-offer">🎁 ${s.offer}</div>` : ""}
        ${s.address ? `<div class="store-row">📍 ${s.address}</div>` : ""}
        ${s.phone ? `<div class="store-row">📞 ${s.phone}</div>` : ""}
        ${s.hours ? `<div class="store-row">🕒 ${s.hours}</div>` : ""}
        ${mapBtn}
      </div>
    </div>
  `;
}

let currentStationId = null;

function openStation(id) {
  currentStationId = id;
  const st = STATIONS.find(s => s.id === id);
  const done = !!state.progress[id];
  // 已完成的站點不管從哪裡點進來（地圖、集章本…）都只顯示「已完成」提示，
  // 不再重新打開劇情/題目——不然玩家從集章本點進已收藏的站點，會看到整份題目又被列出來一次
  if (done) {
    showInfoModal("這一站已完成囉，請前往其他地方闖關。", { title: "已完成" });
    return;
  }
  if (st.location) {
    openArrivalGate(st);
    return;
  }
  enterStationContent(st);
}

function enterStationContent(st) {
  openStationRPG(st); // 每個站點都是用 RPG 對話流程；已完成的站點在 openStation() 就先攔下了，不會走到這裡
}

// ---------- Arrival gate: navigate there via Google Maps, unlock once GPS confirms you're close ----------

let arriveState = null;

function openArrivalGate(st) {
  currentStationId = st.id;
  localStorage.setItem("yingge_pending_arrival", st.id);
  arriveState = { st, watchId: null };
  renderArriveDebugTools();
  document.getElementById("arrive-title").textContent = "NO. " + String(stationDisplayNo(st)).padStart(2, "0") + "　" + st.name.replace(/^站點[一二三四五六七八九十]+\s*/, "");
  document.getElementById("arrive-name").textContent = st.name.replace(/^站點[一二三四五六七八九十]+/, "");
  document.getElementById("arrive-hint").textContent = st.arriveHint
    || (st.address ? `請實際前往「${st.address}」附近，抵達後即可開始遊戲` : "請實際前往站點，抵達後即可開始遊戲");
  const photoEl = document.getElementById("arrive-photo");
  const iconEl = document.getElementById("arrive-icon");
  const arrivePhoto = st.arrivePhoto || st.background;
  if (arrivePhoto) {
    photoEl.style.backgroundImage = `url("${encodeURI(arrivePhoto)}")`;
    photoEl.style.display = "block";
    iconEl.style.display = "none";
  } else {
    photoEl.style.display = "none";
    iconEl.style.display = "block";
  }
  const startBtn = document.getElementById("arrive-start-btn");
  startBtn.disabled = true;
  startBtn.textContent = "抵達後即可開始關卡";
  setArriveStatus("定位中...", "");
  showScreen("screen-arrive");
  startWatchingLocation(st);
}

function startWatchingLocation(st) {
  if (!navigator.geolocation) {
    setArriveStatus("此裝置或瀏覽器不支援定位，請確認已實際抵達後，改用下方連結手動開始", "error");
    return;
  }
  arriveState.watchId = navigator.geolocation.watchPosition(
    pos => handleLocationUpdate(st, pos),
    err => setArriveStatus("無法取得定位（" + (err.message || "權限被拒") + "），請確認已抵達後，改用下方連結手動開始", "error"),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function handleLocationUpdate(st, pos) {
  const dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, st.location.lat, st.location.lng);
  const radius = st.location.radius || 60;
  const startBtn = document.getElementById("arrive-start-btn");
  if (dist <= radius) {
    setArriveStatus(" 你已經抵達現場！可以開始關卡了", "near");
    startBtn.disabled = false;
    startBtn.textContent = "開始關卡";
  } else {
    setArriveStatus(`距離目標約 ${Math.round(dist)} 公尺，再靠近一點`, "far");
    startBtn.disabled = true;
    startBtn.textContent = "抵達後即可開始關卡";
  }
}

function setArriveStatus(text, cls) {
  const el = document.getElementById("arrive-status");
  el.textContent = text;
  el.className = "arrive-status" + (cls ? " " + cls : "");
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function openGoogleNav() {
  const st = arriveState.st;
  const url = `https://www.google.com/maps/dir/?api=1&destination=${st.location.lat},${st.location.lng}&travelmode=walking`;
  window.open(url, "_blank");
}

function confirmArrivalAndStart() {
  const st = arriveState.st;
  localStorage.removeItem("yingge_pending_arrival");
  stopWatchingLocation();
  enterStationContent(st);
}

// ---------- Test-only: simulate a GPS reading without physically travelling there ----------
// 一般玩家的 index.html 原始碼裡完全沒有這塊 UI，只有 shouldShowDebugTools() 為 true
// （本機測試，或登入帳號在 Worker 的 TESTER_EMAILS 白名單裡）才會被動態建出來。
function renderArriveDebugTools() {
  const existing = document.getElementById("arrive-debug-toggle");
  if (existing) existing.remove(); // 每次開啟抵達畫面都重建一次，避免累加出好幾份
  if (!shouldShowDebugTools()) return;

  const card = document.querySelector("#screen-arrive .arrive-card");
  const toggle = document.createElement("div");
  toggle.className = "arrive-debug-toggle";
  toggle.id = "arrive-debug-toggle";
  toggle.textContent = "🧪 測試工具";
  toggle.addEventListener("click", toggleArriveDebug);

  const panel = document.createElement("div");
  panel.className = "arrive-debug";
  panel.id = "arrive-debug";
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="arrive-debug-title">測試工具（僅測試帳號可見）</div>
    <div class="arrive-debug-row">
      <button type="button" id="arrive-debug-near-btn">📍 模擬：我在現場</button>
      <button type="button" id="arrive-debug-far-btn">🚗 模擬：還很遠</button>
    </div>
    <div class="arrive-debug-row">
      <input type="text" id="debug-latlng" placeholder="24.964834, 121.255782">
      <button type="button" id="arrive-debug-custom-btn">套用</button>
    </div>
  `;
  panel.querySelector("#arrive-debug-near-btn").addEventListener("click", simulateAtStation);
  panel.querySelector("#arrive-debug-far-btn").addEventListener("click", simulateFarAway);
  panel.querySelector("#arrive-debug-custom-btn").addEventListener("click", simulateCustom);

  card.appendChild(toggle);
  card.appendChild(panel);
}

function toggleArriveDebug() {
  const panel = document.getElementById("arrive-debug");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
}

function simulateAtStation() {
  if (!arriveState) return;
  stopWatchingLocation(); // stop the real GPS watcher so it can't overwrite the simulated reading
  const st = arriveState.st;
  handleLocationUpdate(st, { coords: { latitude: st.location.lat, longitude: st.location.lng } });
}

function simulateFarAway() {
  if (!arriveState) return;
  stopWatchingLocation();
  const st = arriveState.st;
  handleLocationUpdate(st, { coords: { latitude: st.location.lat + 0.01, longitude: st.location.lng } });
}

function simulateCustom() {
  if (!arriveState) return;
  const raw = document.getElementById("debug-latlng").value;
  const parts = raw.split(",").map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) {
    alert("請輸入「緯度, 經度」格式，例如 24.964834, 121.255782");
    return;
  }
  const [lat, lng] = parts;
  stopWatchingLocation();
  const st = arriveState.st;
  handleLocationUpdate(st, { coords: { latitude: lat, longitude: lng } });
}

function stopWatchingLocation() {
  if (arriveState && arriveState.watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(arriveState.watchId);
  }
  if (arriveState) arriveState.watchId = null;
}

function goToMap() { localStorage.removeItem("yingge_pending_arrival"); stopWatchingLocation(); showMap(); }

function renderStation(st) {
  const container = document.getElementById("station-content");
  const done = !!state.progress[st.id];
  container.innerHTML = "";

  const header = document.createElement("div");
  header.innerHTML = `<h2 style="margin:0 0 4px;font-size:18px;">${st.name.replace(/^站點[一二三四五六七八九十]+/, "")}</h2>` +
    (done ? `<div class="q-done-tag">✓ 本站已完成</div>` : `<p style="color:var(--sub);font-size:13px;margin:0 0 14px;">請依序回答以下 ${st.questions.length} 題，全部答對即完成本站</p>`);
  container.appendChild(header);

  if (st.image) {
    const img = document.createElement("img");
    img.src = st.image;
    img.alt = st.name;
    img.className = "station-image";
    container.appendChild(img);
  }

  if (st.story) {
    const storyEl = document.createElement("div");
    storyEl.className = "story-block";
    storyEl.innerHTML = st.story + `<span class="speak-btn" onclick="speak(${JSON.stringify(st.story)})">🔊</span>`;
    container.appendChild(storyEl);
  }

  st.questions.forEach((q, idx) => {
    const block = document.createElement("div");
    block.className = "q-block";
    block.id = `q-${st.id}-${idx}`;
    block.innerHTML = renderQuestionInner(st, idx, q, done);
    container.appendChild(block);
  });
}

function speakQuestion(stationId, idx) {
  const st = STATIONS.find(s => s.id === stationId);
  const q = st.questions[idx];
  let text = q.question;
  if (q.options && q.options.length) {
    text += "" + q.options.map((opt, i) => `選項${i + 1}：${opt}`).join("");
  }
  speak(text);
}

function renderQuestionInner(st, idx, q, forceLocked) {
  let inner = `<div class="q-title">第 ${idx + 1} 題　${q.qtype}<span class="speak-btn" onclick="speakQuestion(${st.id}, ${idx})">🔊</span></div><div class="q-text">${q.question}</div>`;
  if (q.multi) {
    inner += `<div class="multi-options" id="opts-${st.id}-${idx}">` + q.options.map((opt, i) => `
      <label class="option-check">
        <input type="checkbox" id="chk-${st.id}-${idx}-${i}" value="${escapeAttr(opt)}" ${forceLocked ? "disabled" : ""}>
        <span>${opt}</span>
      </label>`).join("") + `</div>
      <button type="button" class="multi-submit-btn" onclick="submitMulti(${st.id}, ${idx})" ${forceLocked ? "disabled" : ""}>送出</button>`;
  } else if (q.options && q.options.length) {
    inner += q.options.map(opt => {
      const cls = forceLocked ? "option-btn disabled" : "option-btn";
      return `<button type="button" class="${cls}" onclick="submitOption(${st.id}, ${idx}, this, '${escapeAttr(opt)}')">${opt}</button>`;
    }).join("");
  } else {
    inner += `<div class="fill-row">
      <input type="text" id="fill-${st.id}-${idx}" placeholder="輸入答案" ${forceLocked ? "disabled" : ""}>
      <button type="button" onclick="submitFill(${st.id}, ${idx})" ${forceLocked ? "disabled" : ""}>送出</button>
    </div>`;
  }
  inner += `<div class="q-feedback" id="fb-${st.id}-${idx}"></div>`;
  if (q.fact) {
    inner += `<div class="fact-box" id="fact-${st.id}-${idx}" style="display:${forceLocked ? "block" : "none"}">💡 ${q.fact}</div>`;
  }
  return inner;
}

function revealFact(stationId, idx) {
  const el = document.getElementById(`fact-${stationId}-${idx}`);
  if (el) el.style.display = "block";
}

function escapeAttr(s) { return s.replace(/'/g, "\\'"); }

async function submitOption(stationId, idx, btnEl, chosen) {
  const st = STATIONS.find(s => s.id === stationId);
  const allBtns = btnEl.parentElement.querySelectorAll(".option-btn");
  allBtns.forEach(b => b.classList.add("disabled"));
  setFeedback(stationId, idx, null, "判斷中…");
  let res;
  try {
    res = await apiPost({ action: "submitAnswer", code: state.code, stationId, qIndex: idx, answer: chosen });
  } catch (e) {
    allBtns.forEach(b => b.classList.remove("disabled"));
    setFeedback(stationId, idx, false, "連線失敗，請再試一次");
    return;
  }
  if (!res.ok) {
    allBtns.forEach(b => b.classList.remove("disabled"));
    setFeedback(stationId, idx, false, res.error || "發生錯誤，請再試一次");
    return;
  }
  if (res.correct) {
    btnEl.classList.add("correct");
    setFeedback(stationId, idx, true, "答對了！");
    revealFact(stationId, idx);
    checkStationComplete(st);
  } else {
    btnEl.classList.add("wrong");
    setFeedback(stationId, idx, false, "答錯了，再試一次");
    setTimeout(() => { allBtns.forEach(b => b.classList.remove("disabled", "wrong")); setFeedback(stationId, idx, null, ""); }, 900);
  }
}

async function submitMulti(stationId, idx) {
  const st = STATIONS.find(s => s.id === stationId);
  const optsEl = document.getElementById(`opts-${stationId}-${idx}`);
  const checked = Array.from(optsEl.querySelectorAll("input[type=checkbox]:checked")).map(c => c.value);
  if (!checked.length) {
    setFeedback(stationId, idx, false, "請至少勾選一個選項");
    return;
  }
  const checkboxes = optsEl.querySelectorAll("input[type=checkbox]");
  const submitBtn = document.querySelector(`#q-${stationId}-${idx} .multi-submit-btn`);
  checkboxes.forEach(c => { c.disabled = true; });
  if (submitBtn) submitBtn.disabled = true;
  setFeedback(stationId, idx, null, "判斷中…");
  let res;
  try {
    res = await apiPost({ action: "submitAnswer", code: state.code, stationId, qIndex: idx, answer: checked });
  } catch (e) {
    checkboxes.forEach(c => { c.disabled = false; });
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, "連線失敗，請再試一次");
    return;
  }
  if (!res.ok) {
    checkboxes.forEach(c => { c.disabled = false; });
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, res.error || "發生錯誤，請再試一次");
    return;
  }
  if (res.correct) {
    setFeedback(stationId, idx, true, "答對了！");
    revealFact(stationId, idx);
    checkStationComplete(st);
  } else {
    checkboxes.forEach(c => { c.disabled = false; });
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, "答錯了，再試一次");
  }
}

async function submitFill(stationId, idx) {
  const st = STATIONS.find(s => s.id === stationId);
  const input = document.getElementById(`fill-${stationId}-${idx}`);
  const submitBtn = document.querySelector(`#q-${stationId}-${idx} button`);
  const answer = input.value;
  input.disabled = true;
  if (submitBtn) submitBtn.disabled = true;
  setFeedback(stationId, idx, null, "判斷中…");
  let res;
  try {
    res = await apiPost({ action: "submitAnswer", code: state.code, stationId, qIndex: idx, answer });
  } catch (e) {
    input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, "連線失敗，請再試一次");
    return;
  }
  if (!res.ok) {
    input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, res.error || "發生錯誤，請再試一次");
    return;
  }
  if (res.correct) {
    setFeedback(stationId, idx, true, "答對了！");
    revealFact(stationId, idx);
    checkStationComplete(st);
  } else {
    input.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
    setFeedback(stationId, idx, false, "答錯了，再試一次");
  }
}

function setFeedback(stationId, idx, ok, text) {
  const el = document.getElementById(`fb-${stationId}-${idx}`);
  el.textContent = text;
  el.className = "q-feedback" + (ok === true ? " correct" : ok === false ? " wrong" : "");
}

function checkStationComplete(st) {
  // check if every question block on screen shows a correct feedback
  let allCorrect = true;
  st.questions.forEach((q, idx) => {
    const fb = document.getElementById(`fb-${st.id}-${idx}`);
    if (!fb || !fb.classList.contains("correct")) allCorrect = false;
  });
  if (allCorrect) markStationComplete(st);
}

// opts.onComplete：完成後要做的事，預設是原本的「停 500ms 再回地圖」；
// 呼叫端可以自己傳一個 onComplete 進來（例如先播蓋章動畫，動畫播完玩家按繼續才回地圖）。
// wasAlreadyDone 是重播/重新整理時的保護——已經完成過的站點不會再打一次 complete API，
// 也不會執行 onComplete（不會又跳一次蓋章動畫），直接回傳 true 就好
async function markStationComplete(st, opts) {
  const onComplete = (opts && opts.onComplete) || (() => setTimeout(() => afterStationComplete(), 500));
  const wasAlreadyDone = !!state.progress[st.id];
  if (wasAlreadyDone) return true;
  try {
    const res = await apiPost({ action: "complete", code: state.code, stationId: st.id });
    if (!res.ok) {
      alert(res.error || "尚未完成所有題目，請確認後再試一次");
      return false;
    }
    loadPlayerIntoState(res);
    onComplete();
    return true;
  } catch (e) {
    alert("連線失敗，請檢查網路後再試一次");
    return false;
  }
}

