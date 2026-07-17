const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Gist/JSONから読み込んだURLをDOMへ渡す前にHTTPSだけへ制限する。
// URL属性を壊す文字列やjavascript:等は空文字へ落とす。
function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

// 設定画面に表示するアプリ版数。デプロイのたびに上げ、実機で更新が届いたか確認できるようにする
const APP_VERSION = "3.13.0";

const storageKey = "streaming-mobile-viewer-items";
const legacyStorageKey = "unext-mobile-viewer-items";
const deletedKey = "streaming-mobile-viewer-deleted";
const syncConfigKey = "streaming-mobile-viewer-sync";
const savedViewsKey = "tonite-saved-views";

// 作品データはIndexedDBに保存する。
// iOSのlocalStorageは約5MBしかなく、ライブラリが育つと「The quota has been exceeded」で同期が失敗する
const idb = (() => {
  let dbPromise = null;
  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("tonite", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("kv");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }
  return {
    async get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction("kv").objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  };
})();

const state = { items: [], filtered: [], deleted: {}, currentView: "home", pick: null };

const serviceNames = {
  unext: "U-NEXT",
  disney: "Disney+",
  netflix: "Netflix",
  prime: "Prime Video",
  appletv: "Apple TV",
  other: "その他"
};
const serviceShort = { unext: "U-NEXT", disney: "Disney+", netflix: "Netflix", prime: "Prime", appletv: "Apple TV", other: "その他" };
const mediaLabels = { movie: "映画", drama: "ドラマシリーズ", anime: "アニメ", unknown: "未分類" };

// JustWatch由来のプロバイダ名を自分のサービスに正規化する（"Netflix Standard with Ads"や"Amazon Video"の乱立を防ぐ）。
// Apple TVは意図的に除外: JustWatchのApple TVはレンタル/購入ストアで、マイリスト管理の対象外
const PROVIDER_CANON = [
  { re: /netflix/i, key: "netflix" },
  { re: /amazon|prime/i, key: "prime" },
  { re: /disney/i, key: "disney" },
  { re: /u-?next/i, key: "unext" }
];
function canonProviderKey(name) {
  for (const p of PROVIDER_CANON) if (p.re.test(name)) return p.key;
  return null;
}
// この作品を観られる自分のサービス一覧（重複・広告プラン表記は畳む）。保存元サービスは必ず含む
function watchServices(item) {
  const map = new Map();
  const logos = item.providers?.logos || {};
  const add = (names, kind) => {
    for (const name of names || []) {
      const key = canonProviderKey(name);
      if (!key || map.has(key)) continue;
      map.set(key, { key, label: serviceLabel(key), kind, logo: logos[name] || null });
    }
  };
  // 「無料(広告つき)」も追加料金なしという実態は見放題と同じなので、まとめて「見放題」とする
  add([...(item.providers?.flatrate || []), ...(item.providers?.free || []), ...(item.providers?.ads || [])], "見放題");
  add([...(item.providers?.rent || []), ...(item.providers?.buy || [])], "レンタル");
  const own = serviceKey(item);
  if (own !== "other" && !map.has(own)) {
    map.set(own, { key: own, label: serviceLabel(item), kind: item.access || "保存元", logo: null });
  }
  // 他サービスで取り込んだ同一作品（_dupes）も保存元として統合。作品ページへの直接URLを持てる
  const directUrls = { [own]: item.url || null };
  for (const dupe of item._dupes || []) {
    const dupeKey = serviceKey(dupe);
    if (dupeKey === "other") continue;
    directUrls[dupeKey] = directUrls[dupeKey] || dupe.url || null;
    if (!map.has(dupeKey)) map.set(dupeKey, { key: dupeKey, label: serviceLabel(dupe), kind: dupe.access || "保存元", logo: null });
  }
  // 保存元サービスを先頭に。直接URLがあるサービスにはそれを添える
  return [...map.values()]
    .map((svc) => ({ ...svc, url: directUrls[svc.key] || null }))
    .sort((a, b) => (a.key === own ? -1 : 0) - (b.key === own ? -1 : 0));
}
// 保存元以外のサービスへは、そのサービス内の作品検索ページを開く（直接URLは持っていないため）
const SERVICE_SEARCH = {
  netflix: (t) => `https://www.netflix.com/search?q=${encodeURIComponent(t)}`,
  prime: (t) => `https://www.primevideo.com/search/?phrase=${encodeURIComponent(t)}`,
  disney: (t) => `https://www.disneyplus.com/ja-jp/search?q=${encodeURIComponent(t)}`,
  unext: (t) => `https://video.unext.jp/freeword?query=${encodeURIComponent(t)}`,
  appletv: (t) => `https://tv.apple.com/jp/search?term=${encodeURIComponent(t)}`
};
// 視聴リンク: httpsの通常URL（フォールバック用）
function watchUrlFor(key, item, own) {
  return key === own && item.url ? item.url : (SERVICE_SEARCH[key]?.(item.title) || item.providers?.link || "#");
}
// アプリを直接開くURLスキームへの書き換え。スキームが使えない端末でも
// 一定時間で元のhttps URLにフォールバックするので安全に試せる
const APP_SCHEME = {
  netflix: (u) => u.replace(/^https?:\/\/(www\.)?netflix\.com/, "nflx://www.netflix.com"),
  disney: (u) => u.replace(/^https?:\/\//, "disneyplus://"),
  prime: (u) => u.replace(/^https?:\/\//, "primevideo://")
};
function openWatch(key, httpsUrl) {
  httpsUrl = safeHttpsUrl(httpsUrl);
  if (!httpsUrl) return;
  const scheme = APP_SCHEME[key]?.(httpsUrl);
  if (!scheme || scheme === httpsUrl) { window.open(httpsUrl, "_blank", "noreferrer"); return; }
  // スキームでアプリ起動を試み、900ms経っても画面が切り替わらなければブラウザで開く
  const timer = setTimeout(() => window.open(httpsUrl, "_blank", "noreferrer"), 900);
  const onHide = () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onHide); };
  document.addEventListener("visibilitychange", onHide);
  window.location.href = scheme;
}

// 絞り込みの状態（唯一の真実）。DOMではなくここを源にする。
const F = {
  query: "", mediaType: "", service: "", genre: "", duration: "",
  watchState: "", maxRuntime: 0, minRating: 0, expiringSoon: false,
  decade: "", country: "",
  sort: "added"
};

// 同梱しているサービスロゴ（白モノクロ表示用）
const SERVICE_LOGOS = {
  netflix: "logos/netflix.svg",
  prime: "logos/prime.svg",
  disney: "logos/disney.svg",
  appletv: "logos/appletv.svg",
  unext: "logos/unext.svg"
};
// ロゴの縦横比（マスク表示で幅を決めるため）
const SERVICE_LOGO_RATIO = { netflix: 3.7, prime: 3.25, disney: 1.84, appletv: 2.63, unext: 4.13 };
// iOS SafariはSVG画像へのCSSフィルターが不安定なので、マスク方式で白いワードマークを描く
function serviceLogoEl(key, height = 15) {
  if (!SERVICE_LOGOS[key]) return null;
  const el = document.createElement("span");
  el.className = "logo-mask";
  el.style.width = `${Math.round(height * (SERVICE_LOGO_RATIO[key] || 3))}px`;
  el.style.height = `${height}px`;
  el.style.webkitMaskImage = `url(${SERVICE_LOGOS[key]})`;
  el.style.maskImage = `url(${SERVICE_LOGOS[key]})`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", serviceLabel(key));
  return el;
}

// 公開年→年代
const DECADE_LABELS = { "2020s": "2020年代", "2010s": "2010年代", "2000s": "2000年代", "1990s": "90年代", "1980s": "80年代", older: "それ以前" };
function decadeKey(year) {
  if (!Number.isFinite(year)) return "";
  if (year >= 2020) return "2020s";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  if (year >= 1990) return "1990s";
  if (year >= 1980) return "1980s";
  return "older";
}

// 制作国コード→日本語（TMDB補完v7で item.countries に入る）
const COUNTRY_LABELS = {
  US: "アメリカ", JP: "日本", FR: "フランス", KR: "韓国", GB: "イギリス", DE: "ドイツ",
  IT: "イタリア", ES: "スペイン", CN: "中国", HK: "香港", TW: "台湾", IN: "インド",
  CA: "カナダ", AU: "オーストラリア", TH: "タイ", SE: "スウェーデン", DK: "デンマーク",
  MX: "メキシコ", BR: "ブラジル", RU: "ロシア", IE: "アイルランド", NZ: "ニュージーランド",
  BE: "ベルギー", NL: "オランダ", PL: "ポーランド", AR: "アルゼンチン", IR: "イラン"
};
function countryLabel(code) { return COUNTRY_LABELS[code] || code; }

const sampleItems = [
  { id: "sample-1", title: "雨の日に観たいサスペンス", runtime: 96, year: 2019, genres: ["サスペンス", "洋画"], tags: ["雨の日"], note: "サンプル作品です。JSONを読み込むと置き換わります。", service: "unext", mediaType: "movie", rating: 7.8, imdbRating: "7.6", watched: false, favorite: true, url: "https://video.unext.jp/", access: "見放題" },
  { id: "sample-2", title: "週末の長編ドラマ", runtime: 128, year: 2022, genres: ["ドラマ"], tags: ["週末"], service: "netflix", mediaType: "drama", rating: 8.1, watched: false, favorite: false, url: "https://video.unext.jp/", access: "見放題" },
  { id: "sample-3", title: "89分の小さな名作", runtime: 89, year: 2016, genres: ["ヒューマン"], service: "disney", mediaType: "movie", rating: 8.3, imdbRating: "8.2", watched: false, favorite: false, url: "https://video.unext.jp/" }
];

/* ============ 正規化・ユーティリティ（データ層・従来ロジック維持） ============ */
function normalizeList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,、]/);
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}
function normalizeItem(item, index) {
  const runtime = Number(item.runtime);
  const year = Number(item.year);
  return {
    watched: false, favorite: false, hidden: false, tags: [], genres: [],
    addedOrder: index, access: "", image: "", note: "", description: "", url: "",
    ...item,
    service: serviceKey(item),
    serviceName: serviceLabel(item),
    id: item.id || item.url?.match(/SID\d+/i)?.[0]?.toUpperCase() || `mobile-${index}-${Date.now()}`,
    runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    year: Number.isFinite(year) && year > 0 ? year : null,
    tags: normalizeList(item.tags),
    genres: normalizeList(item.genres)
  };
}
function serviceKey(item) {
  if (item?.service) return item.service;
  if (/netflix\.com/i.test(item?.url || "")) return "netflix";
  if (/disneyplus\.com/i.test(item?.url || "")) return "disney";
  if (/primevideo\.com|amazon\.(co\.jp|com)/i.test(item?.url || "")) return "prime";
  if (/tv\.apple\.com/i.test(item?.url || "")) return "appletv";
  if (/unext\.jp/i.test(item?.url || "")) return "unext";
  return "other";
}
function serviceLabel(itemOrKey) {
  const key = typeof itemOrKey === "string" ? itemOrKey : serviceKey(itemOrKey);
  return serviceNames[key] || itemOrKey?.serviceName || "その他";
}
function formatRuntime(value) {
  if (!Number.isFinite(value)) return "時間不明";
  if (value < 60) return `${value}分`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
}
function durationKey(runtime) {
  if (!Number.isFinite(runtime)) return "unknown";
  if (runtime < 80) return "short";
  if (runtime <= 100) return "around90";
  if (runtime < 140) return "around120";
  return "long";
}
function bestRating(item) {
  const imdb = parseFloat(item.imdbRating);
  const tmdb = parseFloat(item.rating);
  return Math.max(Number.isFinite(imdb) ? imdb : 0, Number.isFinite(tmdb) ? tmdb : 0);
}

// ジャンルの日英・表記ゆれを1つの日本語ラベルに正規化（facetの乱立を防ぐ）
const GENRE_CANON = {
  "action": "アクション", "アクション": "アクション",
  "adventure": "アドベンチャー", "アドベンチャー": "アドベンチャー", "冒険": "アドベンチャー",
  "animation": "アニメ", "anime": "アニメ", "アニメ": "アニメ", "アニメーション": "アニメ",
  "comedy": "コメディ", "コメディ": "コメディ", "コメディー": "コメディ",
  "crime": "犯罪", "クライム": "犯罪", "犯罪": "犯罪",
  "documentary": "ドキュメンタリー", "ドキュメンタリー": "ドキュメンタリー", "ドキュメント": "ドキュメンタリー",
  "drama": "ドラマ", "ドラマ": "ドラマ",
  "family": "ファミリー", "ファミリー": "ファミリー", "家族": "ファミリー",
  "fantasy": "ファンタジー", "ファンタジー": "ファンタジー",
  "history": "歴史", "歴史": "歴史", "ヒストリー": "歴史",
  "horror": "ホラー", "ホラー": "ホラー",
  "music": "音楽", "音楽": "音楽", "ミュージック": "音楽",
  "musical": "ミュージカル", "ミュージカル": "ミュージカル",
  "mystery": "ミステリー", "ミステリー": "ミステリー",
  "romance": "ロマンス", "ロマンス": "ロマンス", "恋愛": "ロマンス", "ラブロマンス": "ロマンス", "ラブストーリー": "ロマンス",
  "science fiction": "SF", "sci-fi": "SF", "scifi": "SF", "sf": "SF", "エスエフ": "SF", "サイエンスフィクション": "SF",
  "suspense": "サスペンス", "サスペンス": "サスペンス",
  "thriller": "スリラー", "スリラー": "スリラー",
  "tv movie": "TV映画", "tvムービー": "TV映画",
  "war": "戦争", "ウォー": "戦争", "戦争": "戦争",
  "western": "西部劇", "ウエスタン": "西部劇", "ウェスタン": "西部劇", "西部劇": "西部劇",
  "kids": "キッズ", "キッズ": "キッズ", "子供": "キッズ", "子ども": "キッズ",
  "reality": "リアリティ", "リアリティ": "リアリティ", "バラエティ": "バラエティ",
  "sport": "スポーツ", "sports": "スポーツ", "スポーツ": "スポーツ",
  "human": "ヒューマン", "ヒューマン": "ヒューマン", "ヒューマンドラマ": "ヒューマン"
};
function canonGenre(g) {
  const key = String(g || "").trim();
  if (!key) return "";
  return GENRE_CANON[key] || GENRE_CANON[key.toLowerCase()] || key;
}
function itemGenres(item) {
  return [...new Set((item.genres || []).map(canonGenre).filter(Boolean))];
}
function posterOf(item) {
  // 手動指定は最優先。それ以外は縦型が保証されるTMDBポスターを原則採用し、
  // 無い作品だけサービス側の画像（横長のog:imageが混ざる）で代用する
  if (item.imageLocked) return item.image || "";
  return item.tmdbImage || item.image || "";
}
function searchable(item) {
  return [item.title, item.note, item.description, item.director, ...(item.cast || []), ...(item.tags || []), ...(item.genres || [])]
    .join(" ").toLocaleLowerCase("ja");
}
function daysUntil(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}
function daysSince(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.floor((Date.now() - time) / 86400000);
}

/* ============ フィルタ・ソート ============ */
function matches(item) {
  if (item.hidden) return false;
  if (F.query) { if (!searchable(item).includes(F.query)) return false; }
  if (F.mediaType && (item.mediaType || "unknown") !== F.mediaType) return false;
  if (F.service && serviceKey(item) !== F.service) return false;
  if (F.genre && !itemGenres(item).includes(F.genre)) return false;
  if (F.duration && durationKey(item.runtime) !== F.duration) return false;
  if (F.maxRuntime && (!Number.isFinite(item.runtime) || item.runtime > F.maxRuntime)) return false;
  if (F.minRating && bestRating(item) < F.minRating) return false;
  if (F.decade && decadeKey(item.year) !== F.decade) return false;
  if (F.country && !(item.countries || []).includes(F.country)) return false;
  if (F.expiringSoon) { const d = daysUntil(item.expiresAt); if (d === null || d > 30) return false; }
  if (F.watchState === "unwatched" && item.watched) return false;
  if (F.watchState === "watched" && !item.watched) return false;
  if (F.watchState === "favorite" && !item.favorite) return false;
  return true;
}
function sorter(key) {
  const runtimeValue = (item) => Number.isFinite(item.runtime) ? item.runtime : Number.MAX_SAFE_INTEGER;
  if (key === "title") return (a, b) => a.title.localeCompare(b.title, "ja");
  if (key === "runtimeAsc") return (a, b) => runtimeValue(a) - runtimeValue(b);
  if (key === "runtimeDesc") return (a, b) => (b.runtime || -1) - (a.runtime || -1);
  if (key === "yearDesc") return (a, b) => (b.year || 0) - (a.year || 0);
  if (key === "expiry") return (a, b) => (Date.parse(a.expiresAt) || Infinity) - (Date.parse(b.expiresAt) || Infinity);
  if (key === "ratingDesc") return (a, b) => bestRating(b) - bestRating(a);
  if (key === "backlog") return (a, b) => (Date.parse(a.importedAt) || 0) - (Date.parse(b.importedAt) || 0);
  return (a, b) => (a.addedOrder ?? 999999) - (b.addedOrder ?? 999999);
}
// 同一作品の重複判定キー（タイトルの表記ゆれを吸収。年は±1でグルーピング時に判定）
function dupKey(item) {
  return String(item.title || "")
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/[\s・･·:：!！?？。、,，._／/－‐–—〜~\-]/g, "")
    .toLocaleLowerCase("ja");
}
// 複数サービスで取り込んだ同一作品を1枚に統合する（例: ヘイル・メアリーがU-NEXTとPrimeの両方にある）。
// 代表カードに _dupes として他サービス分をぶら下げ、詳細で両方の保存元を見せる
function dedupeForDisplay(list) {
  const groups = new Map();
  const out = [];
  for (const item of list) {
    const key = dupKey(item);
    const bucket = groups.get(key) || [];
    const primary = bucket.find((p) => !p.year || !item.year || Math.abs(p.year - item.year) <= 1);
    if (primary) {
      primary._dupes.push(item);
    } else {
      const rep = Object.assign(Object.create(Object.getPrototypeOf(item)), item, { _dupes: [] });
      bucket.push(rep);
      groups.set(key, bucket);
      out.push(rep);
    }
  }
  return out;
}

// 代表カードか、その重複分のどれかが条件を満たすか（集計用）
function repMatches(rep, test) {
  return test(rep) || (rep._dupes || []).some(test);
}

function applyFilters() {
  state.filtered = dedupeForDisplay(state.items.filter(matches).sort(sorter(F.sort)));
  return state.filtered;
}
const F_DEFAULTS = { query: "", mediaType: "", service: "", genre: "", duration: "", watchState: "", maxRuntime: 0, minRating: 0, expiringSoon: false, decade: "", country: "", sort: "added" };
function resetFilters() {
  Object.assign(F, F_DEFAULTS);
}

/* ============ 保存・更新 ============ */
async function saveItems() {
  // IndexedDBへ非同期保存（容量制限に強い）。失敗時のみ画面に知らせる
  const itemsSave = idb.set("items", state.items).catch((error) => {
    const status = $("#syncStatus");
    status.hidden = false;
    status.classList.add("is-error");
    status.textContent = "端末への保存に失敗しました（空き容量を確認してください）";
    throw error;
  });
  const deletedSave = idb.set("deleted", state.deleted);
  await Promise.all([itemsSave, deletedSave]);
}
async function patchItem(id, patch) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const now = new Date().toISOString();
  // 視聴状態・お気に入りは、他サービスで取り込んだ同一作品にも揃えて反映する
  const targets = [item];
  if ("watched" in patch || "favorite" in patch) {
    const key = dupKey(item);
    for (const other of state.items) {
      if (other.id !== id && dupKey(other) === key && (!other.year || !item.year || Math.abs(other.year - item.year) <= 1)) {
        targets.push(other);
      }
    }
  }
  targets.forEach((target) => Object.assign(target, patch, { stateUpdatedAt: now, updatedAt: now }));
  await saveItems();
  renderAll();
  GistSync.scheduleSync();
}

/* ============ ビュールーター ============ */
const views = { home: renderHome, library: renderLibrary, picks: renderPicks, settings: renderSettings };
function showView(name) {
  if (!views[name]) name = "home";
  state.currentView = name;
  $$(".view").forEach((el) => { el.hidden = el.dataset.view !== name; });
  $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === name));
  views[name]();
}
function renderAll() {
  // 現在のビューを再描画（データ変更後に呼ぶ）
  views[state.currentView]();
}

/* ============ HOME ============ */
const COLLECTIONS = [
  { id: "recent", icon: "🆕", name: "最近追加", desc: "新しくライブラリに入った作品", test: () => true, apply: (f) => { f.sort = "added"; } },
  { id: "short", icon: "⏱", name: "90分前後", desc: "80〜100分、さくっと観られる一本", test: (i) => durationKey(i.runtime) === "around90", apply: (f) => { f.duration = "around90"; } },
  { id: "top", icon: "★", name: "高評価", desc: "IMDb / TMDB 8.0以上", test: (i) => bestRating(i) >= 8, apply: (f) => { f.minRating = 8; f.sort = "ratingDesc"; } },
  { id: "expiring", icon: "⏳", name: "配信終了間近", desc: "30日以内に終了", test: (i) => { const d = daysUntil(i.expiresAt); return d !== null && d <= 30; }, apply: (f) => { f.expiringSoon = true; f.sort = "expiry"; } },
  { id: "backlog", icon: "📚", name: "積み映画", desc: "長く積んだままの作品", test: (i) => !i.watched && daysSince(i.importedAt) !== null && daysSince(i.importedAt) >= 90, apply: (f) => { f.watchState = "unwatched"; f.sort = "backlog"; } },
  { id: "favorite", icon: "♥", name: "お気に入り", desc: "とっておきの作品", test: (i) => i.favorite, apply: (f) => { f.watchState = "favorite"; } }
];

function renderHome() {
  // 集計はすべて重複統合後のユニーク作品数で統一する
  const reps = dedupeForDisplay(state.items);
  const uniqueCount = (test) => reps.filter((rep) => repMatches(rep, test)).length;
  $("#homeCount").textContent = reps.length;
  const hasItems = state.items.length > 0;
  $("#homeEmpty").hidden = hasItems;
  $$("#homeMediaCards, .section-head, #homeCollections, #homeServices, .home-pick").forEach(() => {});

  // 大ジャンル別カード
  const mediaBox = $("#homeMediaCards");
  mediaBox.replaceChildren();
  [["movie", "映画"], ["drama", "ドラマ"], ["anime", "アニメ"], ["documentary", "ドキュメンタリー"]].forEach(([key, label]) => {
    const count = uniqueCount((i) => (i.mediaType || "unknown") === key);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "media-card" + (count ? "" : " is-empty");
    card.innerHTML = `<span class="mc-count">${count}</span><span class="mc-label">${label}</span>`;
    card.addEventListener("click", () => { resetFilters(); F.mediaType = key === "documentary" ? "" : key; showView("library"); });
    mediaBox.append(card);
  });

  // Smart Collections
  const colBox = $("#homeCollections");
  colBox.replaceChildren();
  COLLECTIONS.forEach((col) => {
    const count = uniqueCount(col.test);
    if (!count && col.id !== "recent") return;
    const row = document.createElement("button");
    row.type = "button";
    row.className = "collection-row";
    row.innerHTML = `<span class="collection-ico">${col.icon}</span>
      <span class="collection-body"><span class="collection-name">${col.name}</span><span class="collection-desc">${col.desc}</span></span>
      <span class="collection-count">${count}</span>`;
    row.addEventListener("click", () => { resetFilters(); col.apply(F); showView("library"); });
    colBox.append(row);
  });

  // サービス別
  const svcBox = $("#homeServices");
  svcBox.replaceChildren();
  const svcCounts = {};
  [...new Set(state.items.map(serviceKey))].forEach((k) => { svcCounts[k] = uniqueCount((i) => serviceKey(i) === k); });
  Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "service-card";
    // 公式ロゴ（白マスク）で表示。ロゴが無いサービスはテキスト
    const logo = serviceLogoEl(key, 14);
    const name = document.createElement("span");
    name.className = `sc-name svc-${key}`;
    if (logo) name.append(logo); else name.textContent = serviceShort[key] || serviceLabel(key);
    const num = document.createElement("span");
    num.className = "sc-count";
    num.textContent = count;
    card.append(name, num);
    card.addEventListener("click", () => { resetFilters(); F.service = key; showView("library"); });
    svcBox.append(card);
  });

  // 今夜の一本プレビュー
  const pick = choosePick();
  const pickBox = $("#homePick");
  pickBox.replaceChildren();
  if (pick) {
    pickBox.innerHTML = `
      <img class="hp-poster" src="${escapeHtml(safeHttpsUrl(posterOf(pick.item)))}" alt="" referrerpolicy="no-referrer" />
      <div class="hp-body">
        <span class="hp-kicker">今夜の一本</span>
        <span class="hp-title">${escapeHtml(pick.item.title)}</span>
        <span class="hp-meta">${[mediaLabels[pick.item.mediaType] || null, serviceLabel(pick.item), formatRuntime(pick.item.runtime)].filter(Boolean).join(" · ")}</span>
        <span class="hp-reason">${escapeHtml(pick.reasons[0] || "")}</span>
      </div>`;
    pickBox.addEventListener("click", () => showView("picks"));
    pickBox.style.display = "";
  } else {
    pickBox.style.display = "none";
  }
}

/* ============ LIBRARY ============ */
const QUICK_CHIPS = [
  { label: "映画", get: () => F.mediaType === "movie", toggle: () => { F.mediaType = F.mediaType === "movie" ? "" : "movie"; } },
  { label: "未視聴", get: () => F.watchState === "unwatched", toggle: () => { F.watchState = F.watchState === "unwatched" ? "" : "unwatched"; } },
  { label: "90分前後", get: () => F.duration === "around90", toggle: () => { F.duration = F.duration === "around90" ? "" : "around90"; F.maxRuntime = 0; } },
  { label: "IMDb 8+", get: () => F.minRating === 8, toggle: () => { F.minRating = F.minRating === 8 ? 0 : 8; } },
  { label: "お気に入り", get: () => F.watchState === "favorite", toggle: () => { F.watchState = F.watchState === "favorite" ? "" : "favorite"; } }
];
let libDensity = localStorage.getItem("tonite-density") || "grid";
let facetsOpen = false;

function hasActiveFilters() {
  return Boolean(F.query || F.mediaType || F.service || F.genre || F.duration || F.watchState || F.maxRuntime || F.minRating || F.expiringSoon || F.decade || F.country);
}

// いまの絞り込み条件を短いラベル列にする（件数ピル用）
function activeConditionLabels() {
  const out = [];
  if (F.query) out.push(`"${F.query}"`);
  if (F.service) out.push(serviceShort[F.service] || serviceLabel(F.service));
  if (F.mediaType) out.push(mediaLabels[F.mediaType]);
  if (F.watchState) out.push({ unwatched: "未視聴", watched: "視聴済み", favorite: "お気に入り" }[F.watchState]);
  if (F.genre) out.push(F.genre);
  if (F.duration) out.push({ short: "80分未満", around90: "90分前後", around120: "120分前後", long: "140分以上", unknown: "時間不明" }[F.duration]);
  if (F.maxRuntime) out.push(`${F.maxRuntime}分以内`);
  if (F.minRating) out.push(`評価${F.minRating}+`);
  if (F.decade) out.push(DECADE_LABELS[F.decade]);
  if (F.country) out.push(countryLabel(F.country));
  if (F.expiringSoon) out.push("終了間近");
  return out;
}

function renderLibrary() {
  $("#libQuery").value = F.query;
  $("#libSort").value = F.sort;

  const fbtn = $("#libFilterBtn");
  fbtn.classList.toggle("is-active", facetsOpen);
  $(".filter-dot", fbtn).hidden = !hasActiveFilters();

  // Quick chips + サービスチップ + ＋
  const chipBox = $("#libQuickChips");
  chipBox.replaceChildren();
  QUICK_CHIPS.forEach((c) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "qchip" + (c.get() ? " is-active" : "");
    chip.textContent = c.label;
    chip.addEventListener("click", () => { c.toggle(); renderLibrary(); });
    chipBox.append(chip);
  });
  const services = [...new Set(state.items.map(serviceKey))];
  services.forEach((key) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "qchip" + (F.service === key ? " is-active" : "");
    chip.textContent = serviceShort[key] || serviceLabel(key);
    chip.addEventListener("click", () => { F.service = F.service === key ? "" : key; renderLibrary(); });
    chipBox.append(chip);
  });
  const more = document.createElement("button");
  more.type = "button";
  more.className = "qchip qchip-more" + (facetsOpen ? " is-active" : "");
  more.textContent = "＋ 絞り込み";
  more.addEventListener("click", () => { facetsOpen = !facetsOpen; renderLibrary(); });
  chipBox.append(more);

  renderSavedViews();
  renderFacets();

  const grid = $("#libGrid");
  grid.className = "poster-grid" + (libDensity === "list" ? " is-list" : "");
  applyFilters();
  grid.replaceChildren();
  state.filtered.forEach((item) => grid.append(createPosterCard(item)));
  $("#libCount").textContent = `${state.filtered.length}件`;
  $("#libEmpty").hidden = state.filtered.length > 0 || state.items.length === 0;

  // 件数行: 「Netflix・映画・90分前後 → 18作品」をヘッダー直下に常時表示
  const conds = activeConditionLabels();
  $("#cpConds").textContent = conds.length ? `${conds.join("・")} → ` : `全ライブラリ `;
  $("#cpNum").textContent = `${state.filtered.length}作品`;
  $("#resetFiltersBtn").hidden = !hasActiveFilters();
}

function renderFacets() {
  const panel = $("#libFacets");
  panel.hidden = !facetsOpen;
  if (!facetsOpen) return;
  panel.replaceChildren();
  const mkRow = (label, kind, options, current, onPick) => {
    const row = document.createElement("div");
    row.className = "facet-row" + (kind === "genre" ? " facet-genre" : "");
    const lab = document.createElement("span");
    lab.className = "facet-label";
    lab.textContent = label;
    const chips = document.createElement("div");
    chips.className = "facet-chips";
    options.forEach(({ value, label: cl, count }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "facet-chip" + (current === value ? " is-active" : "");
      chip.innerHTML = escapeHtml(cl) + (count != null ? ` <span class="facet-count">${count}</span>` : "");
      chip.addEventListener("click", () => { onPick(current === value ? "" : value); renderLibrary(); });
      chips.append(chip);
    });
    row.append(lab, chips);
    panel.append(row);
  };
  // 連動カウント: その次元以外の「いまの絞り込み」を適用したうえでの該当数。
  // Netflixを選ぶと、他の行の数字がNetflix内での件数に切り替わる。
  const countNarrowed = (skipKeys, test) => {
    const saved = {};
    for (const k of skipKeys) { saved[k] = F[k]; F[k] = F_DEFAULTS[k]; }
    // 重複統合後のユニーク作品数で数える（件数ピルやグリッドの数字と必ず一致させる）
    const n = dedupeForDisplay(state.items.filter(matches)).filter((rep) => repMatches(rep, test)).length;
    Object.assign(F, saved);
    return n;
  };
  const countMedia = (v) => countNarrowed(["mediaType"], (i) => (i.mediaType || "unknown") === v);
  const countWatch = (v) => countNarrowed(["watchState"], (i) => v === "unwatched" ? !i.watched : v === "watched" ? i.watched : i.favorite);
  const countDur = (v) => countNarrowed(["duration", "maxRuntime"], (i) => durationKey(i.runtime) === v);
  const countRating = (v) => countNarrowed(["minRating"], (i) => bestRating(i) >= v);
  const countDecade = (v) => countNarrowed(["decade"], (i) => decadeKey(i.year) === v);
  const countCountry = (v) => countNarrowed(["country"], (i) => (i.countries || []).includes(v));
  const countGenre = (v) => countNarrowed(["genre"], (i) => itemGenres(i).includes(v));

  mkRow("大ジャンル", "media", [
    { value: "movie", label: "映画", count: countMedia("movie") },
    { value: "drama", label: "ドラマ", count: countMedia("drama") },
    { value: "anime", label: "アニメ", count: countMedia("anime") },
    { value: "unknown", label: "未分類", count: countMedia("unknown") }
  ], F.mediaType, (v) => { F.mediaType = v; });

  const countSvc = (key) => countNarrowed(["service"], (i) => serviceKey(i) === key);
  const svcKeys = [...new Set(state.items.map(serviceKey))].sort((a, b) => countSvc(b) - countSvc(a));
  if (svcKeys.length) {
    mkRow("サービス", "service", svcKeys.map((key) => ({ value: key, label: serviceShort[key] || serviceLabel(key), count: countSvc(key) })), F.service, (v) => { F.service = v; });
  }

  mkRow("視聴状態", "watch", [
    { value: "", label: "すべて" },
    { value: "unwatched", label: "未視聴", count: countWatch("unwatched") },
    { value: "watched", label: "視聴済み", count: countWatch("watched") },
    { value: "favorite", label: "お気に入り", count: countWatch("favorite") }
  ], F.watchState, (v) => { F.watchState = v; });

  mkRow("上映時間", "duration", [
    { value: "short", label: "80分未満", count: countDur("short") },
    { value: "around90", label: "90分前後", count: countDur("around90") },
    { value: "around120", label: "120分前後", count: countDur("around120") },
    { value: "long", label: "140分以上", count: countDur("long") }
  ], F.duration, (v) => { F.duration = v; F.maxRuntime = 0; });

  mkRow("評価", "rating", [
    { value: 7, label: "7.0+", count: countRating(7) },
    { value: 7.5, label: "7.5+", count: countRating(7.5) },
    { value: 8, label: "8.0+", count: countRating(8) },
    { value: 8.5, label: "8.5+", count: countRating(8.5) }
  ], F.minRating, (v) => { F.minRating = v || 0; });

  mkRow("公開年", "decade", ["2020s", "2010s", "2000s", "1990s", "1980s", "older"]
    .map((d) => ({ value: d, label: DECADE_LABELS[d], count: countDecade(d) }))
    .filter((o) => o.count > 0 || F.decade === o.value), F.decade, (v) => { F.decade = v; });

  // 国: ライブラリに存在する制作国（リストは全体の件数順、表示する数字は連動カウント）
  const countryTotals = {};
  state.items.forEach((i) => (i.countries || []).forEach((c) => { countryTotals[c] = (countryTotals[c] || 0) + 1; }));
  const countries = Object.entries(countryTotals).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (countries.length) {
    mkRow("国", "country", countries.map(([code]) => ({ value: code, label: countryLabel(code), count: countCountry(code) })), F.country, (v) => { F.country = v; });
  }

  const genres = [...new Set(state.items.flatMap(itemGenres))].sort((a, b) => a.localeCompare(b, "ja"));
  if (genres.length) mkRow("ジャンル", "genre", genres.map((g) => ({ value: g, label: g, count: countGenre(g) })), F.genre, (v) => { F.genre = v; });
}

/* ---- 保存ビュー ---- */
const SavedViews = {
  load() { try { return JSON.parse(localStorage.getItem(savedViewsKey) || "[]"); } catch { return []; } },
  save(list) { localStorage.setItem(savedViewsKey, JSON.stringify(list)); },
  add(name) {
    const list = this.load();
    list.push({ name, filter: { ...F } });
    this.save(list);
  },
  remove(index) { const list = this.load(); list.splice(index, 1); this.save(list); }
};
function filterMatchesSaved(saved) {
  return Object.keys(F).every((k) => (F[k] || "") === (saved.filter[k] || ""));
}
function renderSavedViews() {
  const box = $("#savedViews");
  box.replaceChildren();
  const list = SavedViews.load();
  if (!list.length) {
    const hint = document.createElement("span");
    hint.className = "saved-view empty-hint";
    hint.textContent = "よく使う絞り込みを保存できます";
    box.append(hint);
    return;
  }
  list.forEach((sv, index) => {
    const el = document.createElement("span");
    el.className = "saved-view" + (filterMatchesSaved(sv) ? " is-active" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "border:0;background:transparent;color:inherit;font:inherit;padding:0;";
    btn.textContent = sv.name;
    btn.addEventListener("click", () => { Object.assign(F, F_DEFAULTS, sv.filter); renderLibrary(); });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "sv-del";
    del.textContent = "×";
    del.setAttribute("aria-label", `${sv.name}を削除`);
    del.addEventListener("click", (e) => { e.stopPropagation(); SavedViews.remove(index); renderSavedViews(); });
    el.append(btn, del);
    box.append(el);
  });
}

/* ============ ポスターカード ============ */
function createPosterCard(item) {
  const card = $("#posterTemplate").content.firstElementChild.cloneNode(true);
  card.classList.toggle("is-watched", Boolean(item.watched));
  const poster = $(".poster", card);
  const src = safeHttpsUrl(posterOf(item));
  if (src) poster.src = src;
  poster.alt = item.title || "";
  poster.addEventListener("error", () => {
    const fallback = safeHttpsUrl(item.tmdbImage);
    if (fallback && poster.src !== fallback) poster.src = fallback;
    else poster.removeAttribute("src");
  });
  // 横長画像が紛れ込んだら縦型のTMDBポスターに自動で差し替える
  poster.addEventListener("load", () => {
    const fallback = safeHttpsUrl(item.tmdbImage);
    if (poster.naturalWidth > poster.naturalHeight && fallback && !poster.src.includes("image.tmdb.org")) {
      poster.src = fallback;
    }
  });
  if (item.favorite) $(".poster-fav", card).hidden = false;
  if (item.watched) $(".poster-watched", card).hidden = false;
  const badge = $(".poster-badge", card);
  const rating = bestRating(item);
  const remain = item.expiresAt ? daysUntil(item.expiresAt) : null;
  if (remain !== null && remain <= 30) { badge.hidden = false; badge.textContent = remain <= 0 ? "終了間近" : `あと${remain}日`; }
  else if (rating >= 8) { badge.hidden = false; badge.textContent = `★${rating.toFixed(1)}`; }
  $(".poster-title", card).textContent = item.title;
  $(".poster-sub", card).textContent = [serviceShort[serviceKey(item)] || serviceLabel(item), formatRuntime(item.runtime)].filter(Boolean).join(" · ");
  card.addEventListener("click", () => openDetail(item));
  return card;
}

/* ============ PICKS ============ */
// Filmarksで高評価(4.0+)を付けた作品とお気に入りのジャンルから、好みを学習する
function genreAffinity() {
  const liked = state.items.filter((i) => Number(i.filmarksScore) >= 4 || i.favorite);
  const counts = {};
  liked.forEach((i) => itemGenres(i).forEach((g) => { counts[g] = (counts[g] || 0) + 1; }));
  return { counts, total: liked.length };
}
// 未視聴からスコアで一本を選ぶ。理由も添える。
function scoreItem(item, aff) {
  let s = 0;
  const rating = bestRating(item);
  if (rating) s += (rating - 6) * 4;                 // 評価
  const days = daysSince(item.importedAt);
  if (days !== null) s += Math.min(days / 20, 12);   // 積み具合
  const remain = item.expiresAt ? daysUntil(item.expiresAt) : null;
  if (remain !== null && remain <= 30) s += 20 - remain; // 終了間近を優先
  if (Number.isFinite(item.runtime) && item.runtime <= 120) s += 3; // 観やすさ
  if (item.favorite) s += 4;
  if (aff?.total >= 3) {
    // 好みのジャンルとの重なり（最大5点）
    const overlap = itemGenres(item).reduce((sum, g) => sum + (aff.counts[g] || 0), 0);
    s += Math.min((overlap / aff.total) * 10, 5);
  }
  return s;
}
function likedGenreOf(item, aff) {
  if (!aff || aff.total < 3) return null;
  return itemGenres(item).filter((g) => aff.counts[g] >= 2).sort((a, b) => aff.counts[b] - aff.counts[a])[0] || null;
}
function reasonsFor(item, aff) {
  const out = [];
  const days = daysSince(item.importedAt);
  if (days !== null && days >= 60) out.push(`保存から${days}日、そろそろ観たい一本`);
  const remain = item.expiresAt ? daysUntil(item.expiresAt) : null;
  if (remain !== null && remain <= 30) out.push(remain <= 0 ? "まもなく配信終了" : `配信終了まであと${remain}日`);
  const rating = bestRating(item);
  if (rating >= 8) out.push(`IMDb/TMDB ${rating.toFixed(1)} の高評価`);
  const likedGenre = likedGenreOf(item, aff);
  if (likedGenre) out.push(`よく高評価をつける「${likedGenre}」の作品`);
  if (Number.isFinite(item.runtime) && item.runtime <= 100) out.push(`${item.runtime}分、今夜にちょうどいい尺`);
  if (item.favorite) out.push("お気に入りに入れていた作品");
  if (!out.length) out.push(`${serviceLabel(item)}のライブラリから`);
  return out.slice(0, 3);
}
function choosePick(reroll = false) {
  const pool = state.items.filter((i) => !i.watched && !i.hidden);
  if (!pool.length) return null;
  const aff = genreAffinity();
  const ranked = pool.map((i) => ({ item: i, score: scoreItem(i, aff) })).sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, Math.min(6, ranked.length));
  let chosen;
  if (reroll && state.pick) {
    const others = top.filter((t) => t.item.id !== state.pick.item.id);
    chosen = (others.length ? others : top)[Math.floor((state.pickSeed = (state.pickSeed || 1) * 9301 + 49297) % (others.length || top.length))];
    // 疑似ランダム（Math.randomは避け、seedで循環）
    chosen = (others.length ? others : top)[((state.pickSeed >>> 4) % (others.length || top.length))];
  } else {
    chosen = top[0];
  }
  const result = { item: chosen.item, reasons: reasonsFor(chosen.item, aff), alts: top.map((t) => t.item).filter((x) => x.id !== chosen.item.id).slice(0, 4) };
  state.pick = result;
  return result;
}
function renderPicks() {
  const hero = $("#pickHero");
  const pick = state.pick && state.currentView === "picks" && !state.pickDirty ? state.pick : choosePick();
  state.pickDirty = false;
  hero.className = "pick-hero";
  hero.replaceChildren();
  if (!pick) {
    hero.classList.add("empty");
    hero.innerHTML = `<div class="empty-mark">🌙</div><p>未視聴の作品がありません。<br />ライブラリに作品を追加すると、今夜の一本を選びます。</p>`;
  } else {
    const i = pick.item;
    hero.innerHTML = `
      <img class="ph-poster" src="${escapeHtml(safeHttpsUrl(posterOf(i)))}" alt="" referrerpolicy="no-referrer" />
      <div class="pick-hero-inner">
        <div class="ph-kicker">TONIGHT'S PICK</div>
        <h2 class="ph-title">${escapeHtml(i.title)}</h2>
        <div class="ph-meta">${[mediaLabels[i.mediaType] || null, serviceLabel(i), formatRuntime(i.runtime), i.year].filter(Boolean).join(" · ")}</div>
        <div class="ph-reasons">${pick.reasons.map((r) => `<div class="ph-reason">${escapeHtml(r)}</div>`).join("")}</div>
        <div class="ph-actions">
          <button type="button" class="ph-detail">詳細を見る</button>
          <a class="ph-watch" href="${escapeHtml(safeHttpsUrl(i.url) || "#")}" target="_blank" rel="noreferrer">${serviceLabel(i)}で観る</a>
        </div>
      </div>`;
    $(".ph-detail", hero).addEventListener("click", () => openDetail(i));
    $(".ph-poster", hero).addEventListener("click", () => openDetail(i));
  }

  // 積み映画
  const box = $("#backlogList");
  box.replaceChildren();
  const backlog = state.items.filter((i) => !i.watched && daysSince(i.importedAt) !== null)
    .sort((a, b) => (Date.parse(a.importedAt) || 0) - (Date.parse(b.importedAt) || 0)).slice(0, 12);
  if (!backlog.length) {
    const p = document.createElement("p");
    p.className = "collection-desc";
    p.style.padding = "4px 2px";
    p.textContent = "取り込み日が分かる未視聴作品がここに並びます。";
    box.append(p);
  }
  backlog.forEach((i) => {
    const days = daysSince(i.importedAt);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "backlog-row";
    row.innerHTML = `<img class="bl-poster" src="${escapeHtml(safeHttpsUrl(posterOf(i)))}" alt="" referrerpolicy="no-referrer" />
      <div class="backlog-body"><div class="backlog-title">${escapeHtml(i.title)}</div><div class="backlog-sub">${[serviceLabel(i), formatRuntime(i.runtime)].filter(Boolean).join(" · ")}</div></div>
      <div class="backlog-days">${days}日</div>`;
    row.addEventListener("click", () => openDetail(i));
    box.append(row);
  });
}

/* ============ SETTINGS ============ */
function renderSettings() {
  const box = $("#settingsServices");
  box.replaceChildren();
  const svcCounts = {};
  state.items.forEach((i) => { const k = serviceKey(i); svcCounts[k] = (svcCounts[k] || 0) + 1; });
  const known = ["netflix", "disney", "prime", "appletv", "unext"];
  known.forEach((key) => {
    const count = svcCounts[key] || 0;
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.className = "settings-label";
    const dot = document.createElement("span");
    dot.className = `settings-dot ${count ? "on" : ""}`;
    label.append(dot, serviceLogoEl(key, 15) || serviceLabel(key));
    const value = document.createElement("span");
    value.className = "settings-value";
    value.textContent = count ? `${count}作品` : "未接続";
    row.append(label, value);
    box.append(row);
  });
  const cfg = GistSync.getConfig();
  // 最終同期の状態を表示: エラーがあれば内容、成功していれば時刻
  let syncState = "未設定";
  if (cfg.token && cfg.gistId) {
    if (cfg.lastError) syncState = `⚠ ${cfg.lastError}`;
    else if (cfg.lastSyncAt) syncState = `最終同期 ${new Date(cfg.lastSyncAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    else syncState = "接続済み";
  }
  $("#settingsSyncState").textContent = syncState;
  $(".settings-foot").textContent = `TONITE v${APP_VERSION} · あなたの映画ライブラリ`;
}

/* ============ 詳細ダイアログ（従来ロジック維持） ============ */
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function openTrailer(item) {
  const trailerKey = /^[A-Za-z0-9_-]{6,32}$/.test(String(item.trailerKey || "")) ? item.trailerKey : "";
  if (!trailerKey) {
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} 予告編`)}`, "_blank", "noreferrer");
    return;
  }
  $("#trailerTitle").textContent = item.title;
  $("#trailerFrame").src = `https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&playsinline=1`;
  $("#trailerDialog").showModal();
}

function openDetail(item) {
  const content = $("#detailContent");
  content.replaceChildren();
  const posterUrl = safeHttpsUrl(posterOf(item));
  if (posterUrl) {
    const image = document.createElement("img");
    image.src = posterUrl;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    content.append(image);
  }
  const heading = document.createElement("h2");
  heading.textContent = item.title;
  const remaining = item.expiresAt ? daysUntil(item.expiresAt) : null;
  const meta = document.createElement("p");
  meta.className = "detail-meta";
  meta.textContent = [
    item.mediaType && item.mediaType !== "unknown" ? mediaLabels[item.mediaType] : null,
    serviceLabel(item), formatRuntime(item.runtime), item.year,
    (item.countries || []).slice(0, 3).map(countryLabel).join("・") || null,
    item.access,
    remaining !== null && remaining <= 30 ? (remaining <= 0 ? "まもなく終了" : `配信あと${remaining}日`) : null
  ].filter(Boolean).join(" · ");
  content.append(heading, meta);
  if (item.tagline) {
    const tagline = document.createElement("p");
    tagline.className = "detail-tagline";
    tagline.textContent = `“${item.tagline}”`;
    content.append(tagline);
  }

  const scoreTexts = [];
  if (item.rating) scoreTexts.push(`<span class="score-tmdb">★ ${item.rating}</span>`);
  if (item.imdbRating) scoreTexts.push(`<span class="score-imdb">IMDb ${item.imdbRating}</span>`);
  if (item.rtScore) scoreTexts.push(`<span class="score-rt">🍅 ${item.rtScore}%</span>`);
  if (item.filmarksScore) scoreTexts.push(`<span class="score-filmarks">Filmarks ${item.filmarksScore}</span>`);
  if (scoreTexts.length) {
    const scores = document.createElement("div");
    scores.className = "detail-scores";
    scores.innerHTML = scoreTexts.join("");
    content.append(scores);
  }

  // 観られるサービス（正規化・重複排除済み）。タップで保存元は直接、他サービスは作品検索を開く
  const services = watchServices(item);
  if (services.length) {
    const own = serviceKey(item);
    const row = document.createElement("div");
    row.className = "svc-chips";
    // 配信区分の色分け（PCと共通・赤緑色弱でも判別できる2色）: 見放題=青 / レンタル・ポイント=橙
    const kindClassOf = (kind) => /レンタル|購入|ポイント/.test(kind) ? "paid" : "flat";
    services.forEach((svc) => {
      const chip = document.createElement("a");
      chip.className = `svc-chip k-${kindClassOf(svc.kind)}`;
      chip.target = "_blank";
      chip.rel = "noreferrer";
      chip.setAttribute("aria-label", `${svc.label}で観る（${svc.kind}）`);
      // 直接URL（保存元・重複分）を最優先、無ければサービス内検索
      const httpsUrl = safeHttpsUrl(svc.url || watchUrlFor(svc.key, item, own));
      chip.href = httpsUrl || "#";
      // アプリで開く（スキーム起動→ダメならブラウザ）
      chip.addEventListener("click", (event) => {
        if (!httpsUrl || !APP_SCHEME[svc.key]) return; // スキームが無いサービスは通常リンクに任せる
        event.preventDefault();
        openWatch(svc.key, httpsUrl);
      });
      // 横長の公式ワードマークロゴ（白マスク・大きめで視認性を確保）
      const logo = serviceLogoEl(svc.key, 18);
      if (logo) {
        chip.append(logo);
      } else {
        const name = document.createElement("b");
        name.textContent = svc.label;
        chip.append(name);
      }
      const kind = document.createElement("small");
      kind.textContent = svc.kind;
      chip.append(kind);
      row.append(chip);
    });
    content.append(row);
  }
  // 画質・音響: 保存元サービスのページから取得できた分をサービス名付きで全て表示
  // （例: 同一作品がPrimeにもある場合、Prime側のUHD表記もここに出る）
  const qualityLines = [item, ...(item._dupes || [])]
    .map((entry) => ({ label: serviceLabel(entry), tags: entry.quality ? [entry.quality.video, entry.quality.hdr, entry.quality.audio].filter(Boolean) : [] }))
    .filter((line) => line.tags.length);
  if (qualityLines.length) {
    const bl = document.createElement("p");
    bl.className = "detail-badges";
    bl.textContent = qualityLines.map((line) => `${line.label}: ${line.tags.join("・")}`).join("　");
    content.append(bl);
  }

  const desc = document.createElement("p");
  desc.textContent = item.description || "あらすじは登録されていません。";
  content.append(desc);
  if (item.director || item.cast?.length || item.screenplay?.length || item.producers?.length) {
    const credits = document.createElement("p");
    credits.className = "detail-meta";
    credits.textContent = [
      item.director ? `監督: ${item.director}` : null,
      item.cast?.length ? `出演: ${item.cast.slice(0, 5).join(" / ")}` : null,
      item.screenplay?.length ? `脚本: ${item.screenplay.join(" / ")}` : null,
      item.producers?.length ? `製作: ${item.producers.join(" / ")}` : null
    ].filter(Boolean).join("　");
    content.append(credits);
  }
  if (item.unextHighlight) {
    const highlight = document.createElement("p");
    highlight.textContent = `見どころ\n${item.unextHighlight}`;
    highlight.style.whiteSpace = "pre-line";
    content.append(highlight);
  }
  if (item.awards) {
    const awards = document.createElement("p");
    awards.className = "detail-awards";
    awards.textContent = `🏆 ${item.awards}`;
    content.append(awards);
  }
  if (item.note) {
    const note = document.createElement("p");
    note.className = "detail-note";
    note.textContent = `メモ: ${item.note}`;
    content.append(note);
  }

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const fav = document.createElement("button");
  fav.type = "button";
  fav.className = "act-icon" + (item.favorite ? " is-active" : "");
  fav.textContent = item.favorite ? "★" : "☆";
  fav.setAttribute("aria-label", "お気に入り");
  fav.addEventListener("click", () => { patchItem(item.id, { favorite: !item.favorite }); $("#detailDialog").close(); });
  const watchedBtn = document.createElement("button");
  watchedBtn.type = "button";
  watchedBtn.textContent = item.watched ? "戻す" : "観た";
  watchedBtn.addEventListener("click", () => { patchItem(item.id, { watched: !item.watched }); $("#detailDialog").close(); });
  const trailer = document.createElement("button");
  trailer.type = "button";
  trailer.textContent = "▶ 予告編";
  trailer.addEventListener("click", () => openTrailer(item));
  // 「観る」ボタンは廃止。視聴は上の配信サービスチップから（複数サービスに対応）
  actions.append(fav, watchedBtn, trailer);
  content.append(actions);
  $("#detailDialog").showModal();
  // ダイアログは再利用されるため、常に最上部（ポスター）から表示する
  content.scrollTop = 0;
  requestAnimationFrame(() => { content.scrollTop = 0; });
}

/* ============ 読み込み ============ */
async function loadStoredItems() {
  // まずIndexedDBから。無ければ旧localStorageから読み込んで移行し、容量を解放する
  try {
    let stored = await idb.get("items");
    let deleted = await idb.get("deleted");
    if (!Array.isArray(stored)) {
      try { stored = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey) || "[]"); } catch { stored = []; }
      try { deleted = JSON.parse(localStorage.getItem(deletedKey) || "{}"); } catch { deleted = {}; }
      if (Array.isArray(stored) && stored.length) {
        await idb.set("items", stored);
        await idb.set("deleted", deleted && typeof deleted === "object" ? deleted : {});
        // 移行完了後にlocalStorageを空けて「quota exceeded」を根治する
        localStorage.removeItem(storageKey);
        localStorage.removeItem(legacyStorageKey);
        localStorage.removeItem(deletedKey);
      }
    }
    state.items = Array.isArray(stored) ? stored.map(normalizeItem) : [];
    state.deleted = deleted && typeof deleted === "object" && !Array.isArray(deleted) ? deleted : {};
  } catch {
    state.items = [];
    state.deleted = {};
  }
  showView(state.currentView);
}

/* ============ GitHub Gist 同期（従来ロジック維持） ============ */
const GistSync = (() => {
  const GIST_API = "https://api.github.com/gists";
  const GIST_FILE = "mylist.json";
  const TOMBSTONE_LIMIT = 500;
  const STATE_FIELDS = ["watched", "favorite", "hidden", "tags", "note"];
  let pushTimer = null;
  let syncing = false;
  let rerunRequested = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function fetchWithRetry(url, init, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(url, init);
        if (response.status !== 429 && response.status < 500) return response;
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt === attempts - 1) return response;
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) throw error;
      }
      await sleep(800 * (2 ** attempt));
    }
    throw lastError;
  }

  const metaStamp = (item) => Date.parse(item?.updatedAt || item?.lastCheckedAt || item?.importedAt || "") || 0;
  const stateStamp = (item) => Date.parse(item?.stateUpdatedAt || "") || 0;
  const importedStamp = (item) => Date.parse(item?.importedAt || "") || 0;

  // トークン/Gist IDに紛れ込んだ全角文字・改行・ゼロ幅文字を除去する。
  // 不正な文字が1つでもあるとfetchがヘッダー組み立てで失敗し「ネットワークエラー」に見える
  function sanitizeCredential(value) {
    return String(value || "").normalize("NFKC").replace(/[^\x21-\x7e]/g, "");
  }
  function getConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(syncConfigKey) || "{}");
      if (!c || typeof c !== "object") return {};
      return { ...c, token: sanitizeCredential(c.token), gistId: sanitizeCredential(c.gistId) };
    } catch { return {}; }
  }
  function setConfig(config) {
    localStorage.setItem(syncConfigKey, JSON.stringify({
      ...config,
      token: sanitizeCredential(config.token),
      gistId: sanitizeCredential(config.gistId)
    }));
  }
  function setStatus(message, isError = false) {
    const status = $("#syncStatus");
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("is-error", isError);
  }

  // 同期エラーを原因別のわかりやすい日本語にする
  function friendlySyncError(message) {
    const raw = String(message || "");
    if (/401/.test(raw)) {
      const token = getConfig().token || "";
      // 新形式(fine-grained)トークンはGist APIに対応していない。401の一番ありがちな原因
      if (token.startsWith("github_pat_")) {
        return "このトークンは新形式(fine-grained)のため、Gist APIでは使えません。GitHubで「Tokens (classic)」からgistスコープ付きのトークン(ghp_で始まる)を作成するか、PC拡張に保存済みの動いているトークンをそのままコピーしてください";
      }
      return "GitHubトークンが認証されませんでした（失効・削除・コピーミスの可能性）。一番確実なのは、PC拡張の設定画面に保存されている動作中のトークンをそのままコピーすることです";
    }
    if (/quota.*exceeded/i.test(raw)) return "端末の保存容量が足りませんでした。アプリを再読み込みすると保存先が移行されて直ります";
    if (/404/.test(raw)) return "Gistが見つかりません。Gist IDが正しいか、トークンにgistスコープがあるか確認してください";
    if (/403/.test(raw)) return "GitHubに拒否されました（レート制限の可能性）。しばらくしてからもう一度";
    if (/Failed to fetch|Load failed|NetworkError|abort/i.test(raw)) return "ネットワークに接続できません。電波の良い場所で「いま同期する」を試してください";
    return raw;
  }
  function normalizePayload(raw) {
    if (!raw || typeof raw !== "object") return { items: [], deleted: {} };
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    const deleted = raw.deleted && typeof raw.deleted === "object" && !Array.isArray(raw.deleted) ? raw.deleted : {};
    return { items: items.filter((item) => item && item.id), deleted };
  }
  function mergeItem(a, b) {
    const [older, newer] = metaStamp(a) <= metaStamp(b) ? [a, b] : [b, a];
    const merged = { ...older, ...newer };
    const stateSource = stateStamp(a) >= stateStamp(b) ? a : b;
    for (const field of STATE_FIELDS) if (field in stateSource) merged[field] = stateSource[field];
    if (stateSource.stateUpdatedAt) merged.stateUpdatedAt = stateSource.stateUpdatedAt;
    const lockSource = [a, b].filter((x) => x.imageLocked).sort((x, y) => metaStamp(y) - metaStamp(x))[0];
    if (lockSource) { merged.image = lockSource.image; merged.imageLocked = true; }
    const typeSource = [a, b].filter((x) => x.mediaTypeLocked).sort((x, y) => metaStamp(y) - metaStamp(x))[0];
    if (typeSource) { merged.mediaType = typeSource.mediaType; merged.mediaTypeLocked = true; }
    return merged;
  }
  function mergeStates(local, remote) {
    const deleted = { ...local.deleted };
    for (const [id, at] of Object.entries(remote.deleted)) {
      if (!deleted[id] || (Date.parse(at) || 0) > (Date.parse(deleted[id]) || 0)) deleted[id] = at;
    }
    const map = new Map();
    for (const item of [...remote.items, ...local.items]) {
      const existing = map.get(item.id);
      map.set(item.id, existing ? mergeItem(existing, item) : item);
    }
    for (const [id, at] of Object.entries(deleted)) {
      const item = map.get(id);
      const t = Date.parse(at) || 0;
      if (item && stateStamp(item) <= t && importedStamp(item) <= t) map.delete(id);
    }
    const tombstones = Object.entries(deleted)
      .sort((a, b) => (Date.parse(b[1]) || 0) - (Date.parse(a[1]) || 0))
      .slice(0, TOMBSTONE_LIMIT);
    return { items: [...map.values()], deleted: Object.fromEntries(tombstones) };
  }
  async function syncNow() {
    const config = getConfig();
    if (!config.token || !config.gistId) return;
    if (syncing) { rerunRequested = true; return; }
    syncing = true;
    setStatus("同期中…");
    if (state.currentView === "settings") $("#settingsSyncState").textContent = "同期中…";
    try {
      const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.token}` };
      const response = await fetchWithRetry(`${GIST_API}/${config.gistId}`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const gist = await response.json();
      const file = gist.files?.[GIST_FILE];
      let remote = { items: [], deleted: {} };
      if (file) {
        const text = file.truncated ? await (await fetchWithRetry(file.raw_url)).text() : file.content;
        try { remote = normalizePayload(JSON.parse(text)); } catch { throw new Error("Gistの同期データが壊れています。上書きを停止しました"); }
      }
      let merged = mergeStates(normalizePayload({ items: state.items, deleted: state.deleted }), remote);
      // PATCH直前にもう一度読み、同期開始後に別端末で入った変更も取り込む。
      const latestResponse = await fetchWithRetry(`${GIST_API}/${config.gistId}`, { headers });
      if (latestResponse.ok) {
        const latestGist = await latestResponse.json();
        const latestFile = latestGist.files?.[GIST_FILE];
        if (latestFile) {
          const latestText = latestFile.truncated ? await (await fetchWithRetry(latestFile.raw_url)).text() : latestFile.content;
          try { merged = mergeStates(normalizePayload({ items: state.items, deleted: state.deleted }), mergeStates(merged, normalizePayload(JSON.parse(latestText)))); } catch { throw new Error("Gistの同期データが壊れています。上書きを停止しました"); }
        }
      }
      state.items = merged.items.map(normalizeItem);
      state.deleted = merged.deleted;
      await saveItems();
      state.pickDirty = true;
      renderAll();
      const content = JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), items: state.items, deleted: state.deleted });
      const patch = await fetchWithRetry(`${GIST_API}/${config.gistId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ files: { [GIST_FILE]: { content } } })
      });
      if (!patch.ok) throw new Error(`HTTP ${patch.status}`);
      setConfig({ ...getConfig(), lastSyncAt: new Date().toISOString(), lastError: null });
      setStatus(`同期完了（${state.items.length}作品・${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}）`);
      if (state.currentView === "settings") renderSettings();
    } catch (error) {
      let friendly = friendlySyncError(error.message);
      // ネットワークエラーに見える場合、段階的に切り分ける:
      // ①認証なしで同じGist URLに届くか → 届くなら失敗要因はトークンのヘッダー組み立て
      // ②GitHub自体に届くか → 届かなければ本当にネットワーク不通
      if (/ネットワークに接続できません/.test(friendly)) {
        try {
          await fetch(`${GIST_API}/${getConfig().gistId}`, { cache: "no-store" });
          friendly = "トークンの文字列に問題がある可能性があります（コピー時の余分な文字など）。設定でトークンを入力し直してください";
        } catch {
          try {
            const probe = await fetch("https://api.github.com/zen", { cache: "no-store" });
            if (probe.ok) friendly = "GitHubには届いていますが同期リクエストが失敗しました。Gist IDを確認し、もう一度お試しください";
          } catch { /* 本当にネットワーク不通 */ }
        }
      }
      setConfig({ ...getConfig(), lastError: friendly, lastErrorAt: new Date().toISOString() });
      setStatus(`同期に失敗しました: ${friendly}`, true);
      if (state.currentView === "settings") renderSettings();
    } finally {
      syncing = false;
      if (rerunRequested) {
        rerunRequested = false;
        scheduleSync(0);
      }
    }
  }
  function scheduleSync(delay = 2500) {
    const config = getConfig();
    if (!config.token || !config.gistId) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, delay);
  }
  return { syncNow, scheduleSync, getConfig, setConfig };
})();

async function importFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error("ファイルが大きすぎます（上限20MB）");
  const parsed = JSON.parse(await file.text());
  const incoming = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(incoming)) throw new Error("items配列がありません");
  if (incoming.length > 20000) throw new Error("作品数が多すぎます（上限20,000件）");
  if (incoming.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("作品データの形式が正しくありません");
  if (incoming.some((item) => typeof item.title !== "string" || item.title.length > 500)) throw new Error("タイトルが不正な作品があります");
  if (parsed.deleted && typeof parsed.deleted === "object") Object.assign(state.deleted, parsed.deleted);
  if (parsed.preferences && typeof parsed.preferences === "object" && !Array.isArray(parsed.preferences)) {
    if (["grid", "list"].includes(parsed.preferences.density)) {
      libDensity = parsed.preferences.density;
      localStorage.setItem("tonite-density", libDensity);
    }
    if (Array.isArray(parsed.preferences.savedViews)) SavedViews.save(parsed.preferences.savedViews.slice(0, 50));
  }
  const existing = new Map(state.items.map((item) => [item.id, item]));
  incoming.map(normalizeItem).forEach((item) => {
    const previous = existing.get(item.id);
    existing.set(item.id, { ...previous, ...item, watched: previous?.watched ?? item.watched, favorite: previous?.favorite ?? item.favorite });
  });
  state.items = [...existing.values()].map(normalizeItem);
  await saveItems();
  state.pickDirty = true;
  renderAll();
  GistSync.scheduleSync();
}

/* ============ イベント配線 ============ */
// タブ
$$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
$$("[data-goto]").forEach((el) => el.addEventListener("click", () => showView(el.dataset.goto)));

// ライブラリ検索・並び順
$("#libQuery").addEventListener("input", (e) => { F.query = e.target.value.trim().toLocaleLowerCase("ja"); renderLibrary(); });
$("#libSort").addEventListener("change", (e) => { F.sort = e.target.value; renderLibrary(); });
$("#densityToggle").addEventListener("click", () => { libDensity = libDensity === "grid" ? "list" : "grid"; localStorage.setItem("tonite-density", libDensity); renderLibrary(); });
$("#libFilterBtn").addEventListener("click", () => {
  facetsOpen = !facetsOpen;
  renderLibrary();
  if (facetsOpen) requestAnimationFrame(() => $("#libFacets").scrollIntoView({ behavior: "smooth", block: "nearest" }));
});
$("#resetFiltersBtn").addEventListener("click", () => { resetFilters(); renderLibrary(); });

// Picks 再抽選
$("#reshuffle").addEventListener("click", () => { choosePick(true); state.pickDirty = false; renderPicks(); });

// 保存ビュー作成
$("#saveViewBtn").addEventListener("click", () => { $("#saveViewName").value = ""; $("#saveViewDialog").showModal(); });
$("#saveViewCancel").addEventListener("click", () => $("#saveViewDialog").close());
$("#saveViewForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("#saveViewName").value.trim();
  if (name) { SavedViews.add(name); renderSavedViews(); }
  $("#saveViewDialog").close();
});
$("#saveViewDialog").addEventListener("click", (e) => { if (e.target === $("#saveViewDialog")) $("#saveViewDialog").close(); });

// •••メニュー
const moreMenu = $("#moreMenu");
const moreButton = $("#moreButton");
moreButton.addEventListener("click", (event) => { event.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; });
document.addEventListener("click", (event) => { if (!moreMenu.contains(event.target) && event.target !== moreButton) moreMenu.hidden = true; });
moreMenu.querySelectorAll("button, label").forEach((el) => el.addEventListener("click", () => { moreMenu.hidden = true; }));

// データ操作（ホームメニュー & 設定）
function handleImport(input) {
  input.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await importFile(file); } catch (error) { alert(`読み込めませんでした: ${error.message}`); }
    finally { event.target.value = ""; }
  });
}
handleImport($("#importJson"));
handleImport($("#importJson2"));

function exportJson() {
  const preferences = { density: libDensity, savedViews: SavedViews.load() };
  const payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), items: state.items, deleted: state.deleted, preferences }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tonite-mylist-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#exportJson").addEventListener("click", exportJson);
$("#settingsExport").addEventListener("click", exportJson);

async function clearAll() {
  if (!confirm("この端末に保存した作品データを削除しますか？（同期先のデータは残り、次回同期で戻ります）")) return;
  state.items = [];
  await saveItems();
  state.pickDirty = true;
  renderAll();
}
$("#clearAll").addEventListener("click", clearAll);
$("#settingsClear").addEventListener("click", clearAll);

$("#loadSample").addEventListener("click", async () => { state.items = sampleItems.map(normalizeItem); await saveItems(); state.pickDirty = true; renderAll(); });

// 同期ダイアログ
function openSyncDialog() {
  const config = GistSync.getConfig();
  $("#syncToken").value = config.token || "";
  $("#syncGistId").value = config.gistId || "";
  $("#syncDialog").showModal();
}
$("#syncButton").addEventListener("click", openSyncDialog);
$("#settingsSync").addEventListener("click", openSyncDialog);
$("#settingsSyncNow").addEventListener("click", () => {
  // 押した瞬間に反応を返す（結果はsyncNowが同期完了/失敗で上書きする）
  $("#settingsSyncState").textContent = "同期中…";
  GistSync.syncNow();
});
$("#syncCancel").addEventListener("click", () => $("#syncDialog").close());
$("#syncForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("#syncToken").value.trim();
  // 保存前にトークン形式をチェックして、間違った種類のトークンで悩まないようにする
  if (token.startsWith("github_pat_")) {
    alert("このトークンは新形式(fine-grained)のため、Gist同期では使えません。\nGitHubの「Tokens (classic)」でgistスコープ付きのトークン(ghp_で始まる)を作成してください。\nPC拡張で同期できているなら、そのトークンをコピーするのが確実です。");
    return;
  }
  GistSync.setConfig({ token, gistId: $("#syncGistId").value.trim() });
  $("#syncDialog").close();
  GistSync.syncNow();
});
$("#syncDialog").addEventListener("click", (event) => { if (event.target === $("#syncDialog")) $("#syncDialog").close(); });

// 詳細・予告編ダイアログ
$("#detailClose").addEventListener("click", () => $("#detailDialog").close());
$("#detailDialog").addEventListener("click", (event) => { if (event.target === $("#detailDialog")) $("#detailDialog").close(); });
$("#trailerClose").addEventListener("click", () => $("#trailerDialog").close());
$("#trailerDialog").addEventListener("close", () => { $("#trailerFrame").src = ""; });
$("#trailerDialog").addEventListener("click", (event) => { if (event.target === $("#trailerDialog")) $("#trailerDialog").close(); });

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadStoredItems().then(() => GistSync.syncNow());
