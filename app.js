const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const storageKey = "streaming-mobile-viewer-items";
const legacyStorageKey = "unext-mobile-viewer-items";
const deletedKey = "streaming-mobile-viewer-deleted";
const syncConfigKey = "streaming-mobile-viewer-sync";
const savedViewsKey = "tonite-saved-views";
const recentSearchKey = "tonite-recent-search";

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

// 絞り込みの状態（唯一の真実）。DOMではなくここを源にする。
const F = {
  query: "", mediaType: "", service: "", genre: "", duration: "",
  watchState: "", maxRuntime: 0, minRating: 0, expiringSoon: false,
  sort: "added"
};

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
  if (item.imageLocked) return item.image || "";
  if (serviceKey(item) === "prime" && item.tmdbImage) return item.tmdbImage;
  return item.image || item.tmdbImage || "";
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
function applyFilters() {
  state.filtered = state.items.filter(matches).sort(sorter(F.sort));
  return state.filtered;
}
function resetFilters() {
  Object.assign(F, { query: "", mediaType: "", service: "", genre: "", duration: "", watchState: "", maxRuntime: 0, minRating: 0, expiringSoon: false, sort: "added" });
}

/* ============ 保存・更新 ============ */
function saveItems() {
  localStorage.setItem(storageKey, JSON.stringify(state.items));
  localStorage.setItem(deletedKey, JSON.stringify(state.deleted));
}
function patchItem(id, patch) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const now = new Date().toISOString();
  Object.assign(item, patch, { stateUpdatedAt: now, updatedAt: now });
  saveItems();
  renderAll();
  GistSync.scheduleSync();
}

/* ============ ビュールーター ============ */
const views = { home: renderHome, library: renderLibrary, search: renderSearch, picks: renderPicks, settings: renderSettings };
function showView(name) {
  if (!views[name]) name = "home";
  state.currentView = name;
  $$(".view").forEach((el) => { el.hidden = el.dataset.view !== name; });
  $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === name));
  views[name]();
  if (name === "search") setTimeout(() => $("#searchInput").focus(), 60);
}
function renderAll() {
  // 現在のビューを再描画（データ変更後に呼ぶ）
  views[state.currentView]();
}

/* ============ HOME ============ */
const COLLECTIONS = [
  { id: "recent", icon: "🆕", name: "最近追加", desc: "新しくライブラリに入った作品", test: () => true, apply: (f) => { f.sort = "added"; } },
  { id: "unwatched", icon: "◐", name: "未視聴", desc: "まだ観ていない作品", test: (i) => !i.watched, apply: (f) => { f.watchState = "unwatched"; } },
  { id: "short", icon: "⏱", name: "90分以内", desc: "さくっと観られる一本", test: (i) => Number.isFinite(i.runtime) && i.runtime <= 90, apply: (f) => { f.maxRuntime = 90; } },
  { id: "top", icon: "★", name: "高評価", desc: "IMDb / TMDB 8.0以上", test: (i) => bestRating(i) >= 8, apply: (f) => { f.minRating = 8; f.sort = "ratingDesc"; } },
  { id: "expiring", icon: "⏳", name: "配信終了間近", desc: "30日以内に終了", test: (i) => { const d = daysUntil(i.expiresAt); return d !== null && d <= 30; }, apply: (f) => { f.expiringSoon = true; f.sort = "expiry"; } },
  { id: "backlog", icon: "📚", name: "積み映画", desc: "長く積んだままの作品", test: (i) => !i.watched && daysSince(i.importedAt) !== null && daysSince(i.importedAt) >= 90, apply: (f) => { f.watchState = "unwatched"; f.sort = "backlog"; } },
  { id: "favorite", icon: "♥", name: "お気に入り", desc: "とっておきの作品", test: (i) => i.favorite, apply: (f) => { f.watchState = "favorite"; } }
];

function renderHome() {
  $("#homeCount").textContent = state.items.length;
  const hasItems = state.items.length > 0;
  $("#homeEmpty").hidden = hasItems;
  $$("#homeMediaCards, .section-head, #homeCollections, #homeServices, .home-pick").forEach(() => {});

  // 大ジャンル別カード
  const mediaBox = $("#homeMediaCards");
  mediaBox.replaceChildren();
  [["movie", "映画"], ["drama", "ドラマ"], ["anime", "アニメ"], ["documentary", "ドキュメンタリー"]].forEach(([key, label]) => {
    const count = state.items.filter((i) => (i.mediaType || "unknown") === key).length;
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
    const count = state.items.filter(col.test).length;
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
  state.items.forEach((i) => { const k = serviceKey(i); svcCounts[k] = (svcCounts[k] || 0) + 1; });
  Object.entries(svcCounts).sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "service-card";
    card.innerHTML = `<span class="sc-name svc-${key}">${serviceShort[key] || serviceLabel(key)}</span><span class="sc-count">${count}</span>`;
    card.addEventListener("click", () => { resetFilters(); F.service = key; showView("library"); });
    svcBox.append(card);
  });

  // 今夜の一本プレビュー
  const pick = choosePick();
  const pickBox = $("#homePick");
  pickBox.replaceChildren();
  if (pick) {
    pickBox.innerHTML = `
      <img class="hp-poster" src="${posterOf(pick.item)}" alt="" referrerpolicy="no-referrer" />
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
  { label: "90分以内", get: () => F.maxRuntime === 90, toggle: () => { F.maxRuntime = F.maxRuntime === 90 ? 0 : 90; } },
  { label: "IMDb 8+", get: () => F.minRating === 8, toggle: () => { F.minRating = F.minRating === 8 ? 0 : 8; } },
  { label: "お気に入り", get: () => F.watchState === "favorite", toggle: () => { F.watchState = F.watchState === "favorite" ? "" : "favorite"; } }
];
let libDensity = localStorage.getItem("tonite-density") || "grid";
let facetsOpen = false;

function hasActiveFilters() {
  return Boolean(F.query || F.mediaType || F.service || F.genre || F.duration || F.watchState || F.maxRuntime || F.minRating || F.expiringSoon);
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
  const countMedia = (v) => state.items.filter((i) => (i.mediaType || "unknown") === v).length;
  const countDur = (v) => state.items.filter((i) => durationKey(i.runtime) === v).length;
  const countGenre = (v) => state.items.filter((i) => itemGenres(i).includes(v)).length;

  mkRow("大ジャンル", "media", [
    { value: "movie", label: "映画", count: countMedia("movie") },
    { value: "drama", label: "ドラマ", count: countMedia("drama") },
    { value: "anime", label: "アニメ", count: countMedia("anime") },
    { value: "unknown", label: "未分類", count: countMedia("unknown") }
  ], F.mediaType, (v) => { F.mediaType = v; });

  mkRow("視聴状態", "watch", [
    { value: "unwatched", label: "未視聴" },
    { value: "watched", label: "視聴済み" },
    { value: "favorite", label: "お気に入り" }
  ], F.watchState, (v) => { F.watchState = v; });

  mkRow("上映時間", "duration", [
    { value: "short", label: "80分未満", count: countDur("short") },
    { value: "around90", label: "90分前後", count: countDur("around90") },
    { value: "around120", label: "120分前後", count: countDur("around120") },
    { value: "long", label: "140分以上", count: countDur("long") }
  ], F.duration, (v) => { F.duration = v; F.maxRuntime = 0; });

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
    btn.addEventListener("click", () => { Object.assign(F, { query: "", mediaType: "", service: "", genre: "", duration: "", watchState: "", maxRuntime: 0, minRating: 0, expiringSoon: false, sort: "added" }, sv.filter); renderLibrary(); });
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
  const src = posterOf(item);
  if (src) poster.src = src;
  poster.alt = item.title || "";
  poster.addEventListener("error", () => {
    if (item.tmdbImage && poster.src !== item.tmdbImage) poster.src = item.tmdbImage;
    else poster.removeAttribute("src");
  });
  if (item.favorite) $(".poster-fav", card).hidden = false;
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

/* ============ SEARCH ============ */
function recentSearches() { try { return JSON.parse(localStorage.getItem(recentSearchKey) || "[]"); } catch { return []; } }
function pushRecentSearch(q) {
  q = q.trim();
  if (!q) return;
  const list = recentSearches().filter((x) => x !== q);
  list.unshift(q);
  localStorage.setItem(recentSearchKey, JSON.stringify(list.slice(0, 8)));
}
function renderSearch() {
  const input = $("#searchInput");
  const q = input.value.trim().toLocaleLowerCase("ja");
  const suggest = $("#searchSuggest");
  const results = $("#searchResults");

  if (!q) {
    results.replaceChildren();
    suggest.replaceChildren();
    // 候補: 気分プリセット + 最近の検索
    const presets = [
      { label: "90分以内で観たい", run: () => { resetFilters(); F.maxRuntime = 90; showView("library"); } },
      { label: "高評価の未視聴", run: () => { resetFilters(); F.minRating = 8; F.watchState = "unwatched"; F.sort = "ratingDesc"; showView("library"); } },
      { label: "積みっぱなしの映画", run: () => { resetFilters(); F.watchState = "unwatched"; F.sort = "backlog"; showView("library"); } },
      { label: "お気に入りをもう一度", run: () => { resetFilters(); F.watchState = "favorite"; showView("library"); } }
    ];
    const g1 = document.createElement("div");
    g1.className = "suggest-group";
    g1.innerHTML = `<h3>こんな気分は？</h3>`;
    const c1 = document.createElement("div");
    c1.className = "suggest-chips";
    presets.forEach((p) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "suggest-chip";
      chip.textContent = p.label;
      chip.addEventListener("click", p.run);
      c1.append(chip);
    });
    g1.append(c1);
    suggest.append(g1);

    const recents = recentSearches();
    if (recents.length) {
      const g2 = document.createElement("div");
      g2.className = "suggest-group";
      g2.innerHTML = `<h3>最近の検索</h3>`;
      const c2 = document.createElement("div");
      c2.className = "suggest-chips";
      recents.forEach((r) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "suggest-chip";
        chip.innerHTML = `${escapeHtml(r)} <span class="sc-x">↗</span>`;
        chip.addEventListener("click", () => { input.value = r; renderSearch(); });
        c2.append(chip);
      });
      g2.append(c2);
      suggest.append(g2);
    }
    return;
  }

  suggest.replaceChildren();
  const hits = state.items.filter((i) => searchable(i).includes(q)).sort(sorter("ratingDesc"));
  results.className = "poster-grid";
  results.replaceChildren();
  if (!hits.length) {
    const none = document.createElement("div");
    none.className = "empty";
    none.innerHTML = `<div class="empty-mark">🔍</div><h2>「${escapeHtml(input.value.trim())}」に一致なし</h2><p>別のキーワードを試してみてください。</p>`;
    results.append(none);
    return;
  }
  hits.forEach((item) => results.append(createPosterCard(item)));
}

/* ============ PICKS ============ */
// 未視聴からスコアで一本を選ぶ。理由も添える。
function scoreItem(item) {
  let s = 0;
  const rating = bestRating(item);
  if (rating) s += (rating - 6) * 4;                 // 評価
  const days = daysSince(item.importedAt);
  if (days !== null) s += Math.min(days / 20, 12);   // 積み具合
  const remain = item.expiresAt ? daysUntil(item.expiresAt) : null;
  if (remain !== null && remain <= 30) s += 20 - remain; // 終了間近を優先
  if (Number.isFinite(item.runtime) && item.runtime <= 120) s += 3; // 観やすさ
  if (item.favorite) s += 4;
  return s;
}
function reasonsFor(item) {
  const out = [];
  const days = daysSince(item.importedAt);
  if (days !== null && days >= 60) out.push(`保存から${days}日、そろそろ観たい一本`);
  const remain = item.expiresAt ? daysUntil(item.expiresAt) : null;
  if (remain !== null && remain <= 30) out.push(remain <= 0 ? "まもなく配信終了" : `配信終了まであと${remain}日`);
  const rating = bestRating(item);
  if (rating >= 8) out.push(`IMDb/TMDB ${rating.toFixed(1)} の高評価`);
  if (Number.isFinite(item.runtime) && item.runtime <= 100) out.push(`${item.runtime}分、今夜にちょうどいい尺`);
  if (item.favorite) out.push("お気に入りに入れていた作品");
  if (!out.length) out.push(`${serviceLabel(item)}のライブラリから`);
  return out.slice(0, 3);
}
function choosePick(reroll = false) {
  const pool = state.items.filter((i) => !i.watched && !i.hidden);
  if (!pool.length) return null;
  const ranked = pool.map((i) => ({ item: i, score: scoreItem(i) })).sort((a, b) => b.score - a.score);
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
  const result = { item: chosen.item, reasons: reasonsFor(chosen.item), alts: top.map((t) => t.item).filter((x) => x.id !== chosen.item.id).slice(0, 4) };
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
      <img class="ph-poster" src="${posterOf(i)}" alt="" referrerpolicy="no-referrer" />
      <div class="pick-hero-inner">
        <div class="ph-kicker">TONIGHT'S PICK</div>
        <h2 class="ph-title">${escapeHtml(i.title)}</h2>
        <div class="ph-meta">${[mediaLabels[i.mediaType] || null, serviceLabel(i), formatRuntime(i.runtime), i.year].filter(Boolean).join(" · ")}</div>
        <div class="ph-reasons">${pick.reasons.map((r) => `<div class="ph-reason">${escapeHtml(r)}</div>`).join("")}</div>
        <div class="ph-actions">
          <button type="button" class="ph-detail">詳細を見る</button>
          <a class="ph-watch" href="${i.url || "#"}" target="_blank" rel="noreferrer">${serviceLabel(i)}で観る</a>
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
    row.innerHTML = `<img class="bl-poster" src="${posterOf(i)}" alt="" referrerpolicy="no-referrer" />
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
    row.innerHTML = `<span class="settings-label"><span class="settings-dot ${count ? "on" : ""}"></span>${serviceLabel(key)}</span><span class="settings-value">${count ? `${count}作品` : "未接続"}</span>`;
    box.append(row);
  });
  const cfg = GistSync.getConfig();
  $("#settingsSyncState").textContent = cfg.token && cfg.gistId ? "接続済み" : "未設定";
}

/* ============ 詳細ダイアログ（従来ロジック維持） ============ */
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function openTrailer(item) {
  if (!item.trailerKey) {
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} 予告編`)}`, "_blank", "noreferrer");
    return;
  }
  $("#trailerTitle").textContent = item.title;
  $("#trailerFrame").src = `https://www.youtube-nocookie.com/embed/${item.trailerKey}?autoplay=1&playsinline=1`;
  $("#trailerDialog").showModal();
}

function openDetail(item) {
  const content = $("#detailContent");
  content.replaceChildren();
  const posterUrl = posterOf(item);
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
    serviceLabel(item), formatRuntime(item.runtime), item.year, item.access,
    remaining !== null && remaining <= 30 ? (remaining <= 0 ? "まもなく終了" : `配信あと${remaining}日`) : null
  ].filter(Boolean).join(" · ");
  content.append(heading, meta);

  const scoreTexts = [];
  if (item.rating) scoreTexts.push(`<span class="score-tmdb">★ ${item.rating}</span>`);
  if (item.imdbRating) scoreTexts.push(`<span class="score-imdb">IMDb ${item.imdbRating}</span>`);
  if (item.rtScore) scoreTexts.push(`<span class="score-rt">🍅 ${item.rtScore}%</span>`);
  if (scoreTexts.length) {
    const scores = document.createElement("div");
    scores.className = "detail-scores";
    scores.innerHTML = scoreTexts.join("");
    content.append(scores);
  }

  const qTags = item.quality ? [item.quality.video, item.quality.hdr, item.quality.audio].filter(Boolean) : [];
  const provNames = item.providers ? [
    ...(item.providers.flatrate || []).map((n) => `${n}（見放題）`),
    ...[...new Set([...(item.providers.rent || []), ...(item.providers.buy || [])])].map((n) => `${n}（レンタル）`)
  ] : [];
  const badges = [...qTags, ...provNames.slice(0, 6)];
  if (badges.length) {
    const bl = document.createElement("p");
    bl.className = "detail-badges";
    bl.textContent = badges.join(" ・ ");
    content.append(bl);
  }

  const desc = document.createElement("p");
  desc.textContent = item.description || "あらすじは登録されていません。";
  content.append(desc);
  if (item.director || (item.cast && item.cast.length)) {
    const credits = document.createElement("p");
    credits.className = "detail-meta";
    credits.textContent = [item.director ? `監督: ${item.director}` : null, item.cast && item.cast.length ? `出演: ${item.cast.slice(0, 4).join(" / ")}` : null].filter(Boolean).join("　");
    content.append(credits);
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
  const watch = document.createElement("a");
  watch.href = item.url || "https://video.unext.jp/";
  watch.target = "_blank";
  watch.rel = "noreferrer";
  watch.textContent = `${serviceLabel(item)}で観る`;
  actions.append(fav, watchedBtn, trailer, watch);
  content.append(actions);
  $("#detailDialog").showModal();
}

/* ============ 読み込み ============ */
function loadStoredItems() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey) || "[]");
    state.items = Array.isArray(stored) ? stored.map(normalizeItem) : [];
  } catch { state.items = []; }
  try {
    const deleted = JSON.parse(localStorage.getItem(deletedKey) || "{}");
    state.deleted = deleted && typeof deleted === "object" && !Array.isArray(deleted) ? deleted : {};
  } catch { state.deleted = {}; }
  showView(state.currentView);
}

/* ============ GitHub Gist 同期（従来ロジック維持） ============ */
const GistSync = (() => {
  const GIST_API = "https://api.github.com/gists";
  const GIST_FILE = "mylist.json";
  const STATE_FIELDS = ["watched", "favorite", "hidden", "tags", "note"];
  let pushTimer = null;
  let syncing = false;

  const metaStamp = (item) => Date.parse(item?.updatedAt || item?.lastCheckedAt || item?.importedAt || "") || 0;
  const stateStamp = (item) => Date.parse(item?.stateUpdatedAt || "") || 0;
  const importedStamp = (item) => Date.parse(item?.importedAt || "") || 0;

  function getConfig() {
    try { const c = JSON.parse(localStorage.getItem(syncConfigKey) || "{}"); return c && typeof c === "object" ? c : {}; }
    catch { return {}; }
  }
  function setConfig(config) { localStorage.setItem(syncConfigKey, JSON.stringify(config)); }
  function setStatus(message, isError = false) {
    const status = $("#syncStatus");
    status.hidden = !message;
    status.textContent = message || "";
    status.classList.toggle("is-error", isError);
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
    return { items: [...map.values()], deleted };
  }
  async function syncNow() {
    const config = getConfig();
    if (!config.token || !config.gistId || syncing) return;
    syncing = true;
    setStatus("同期中…");
    try {
      const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${config.token}` };
      const response = await fetch(`${GIST_API}/${config.gistId}`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const gist = await response.json();
      const file = gist.files?.[GIST_FILE];
      let remote = { items: [], deleted: {} };
      if (file) {
        const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
        try { remote = normalizePayload(JSON.parse(text)); } catch { /* 壊れたデータは空扱い */ }
      }
      const merged = mergeStates(normalizePayload({ items: state.items, deleted: state.deleted }), remote);
      state.items = merged.items.map(normalizeItem);
      state.deleted = merged.deleted;
      saveItems();
      state.pickDirty = true;
      renderAll();
      const content = JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), items: state.items, deleted: state.deleted });
      const patch = await fetch(`${GIST_API}/${config.gistId}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ files: { [GIST_FILE]: { content } } })
      });
      if (!patch.ok) throw new Error(`HTTP ${patch.status}`);
      setStatus(`同期完了（${state.items.length}作品・${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}）`);
    } catch (error) {
      setStatus(`同期に失敗しました: ${error.message}`, true);
    } finally {
      syncing = false;
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
  const parsed = JSON.parse(await file.text());
  const incoming = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(incoming)) throw new Error("items配列がありません");
  if (parsed.deleted && typeof parsed.deleted === "object") Object.assign(state.deleted, parsed.deleted);
  const existing = new Map(state.items.map((item) => [item.id, item]));
  incoming.map(normalizeItem).forEach((item) => {
    const previous = existing.get(item.id);
    existing.set(item.id, { ...previous, ...item, watched: previous?.watched ?? item.watched, favorite: previous?.favorite ?? item.favorite });
  });
  state.items = [...existing.values()].map(normalizeItem);
  saveItems();
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

// 検索
$("#searchInput").addEventListener("input", renderSearch);
$("#searchInput").addEventListener("change", (e) => pushRecentSearch(e.target.value));

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
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tonite-mylist-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("#exportJson").addEventListener("click", exportJson);
$("#settingsExport").addEventListener("click", exportJson);

function clearAll() {
  if (!confirm("この端末に保存した作品データを削除しますか？（同期先のデータは残り、次回同期で戻ります）")) return;
  state.items = [];
  saveItems();
  state.pickDirty = true;
  renderAll();
}
$("#clearAll").addEventListener("click", clearAll);
$("#settingsClear").addEventListener("click", clearAll);

$("#loadSample").addEventListener("click", () => { state.items = sampleItems.map(normalizeItem); saveItems(); state.pickDirty = true; renderAll(); });

// 同期ダイアログ
function openSyncDialog() {
  const config = GistSync.getConfig();
  $("#syncToken").value = config.token || "";
  $("#syncGistId").value = config.gistId || "";
  $("#syncDialog").showModal();
}
$("#syncButton").addEventListener("click", openSyncDialog);
$("#settingsSync").addEventListener("click", openSyncDialog);
$("#settingsSyncNow").addEventListener("click", () => GistSync.syncNow());
$("#syncCancel").addEventListener("click", () => $("#syncDialog").close());
$("#syncForm").addEventListener("submit", (event) => {
  event.preventDefault();
  GistSync.setConfig({ token: $("#syncToken").value.trim(), gistId: $("#syncGistId").value.trim() });
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

loadStoredItems();
GistSync.syncNow();
