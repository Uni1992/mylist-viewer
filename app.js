const $ = (selector, root = document) => root.querySelector(selector);
const storageKey = "streaming-mobile-viewer-items";
const legacyStorageKey = "unext-mobile-viewer-items";
const deletedKey = "streaming-mobile-viewer-deleted";
const syncConfigKey = "streaming-mobile-viewer-sync";
const state = { items: [], filtered: [], deleted: {} };

const serviceNames = {
  unext: "U-NEXT",
  disney: "Disney+",
  netflix: "Netflix",
  prime: "Prime Video",
  other: "その他"
};

const mediaLabels = { movie: "映画", drama: "ドラマシリーズ", anime: "アニメ", unknown: "未分類" };

const bands = {
  short: { label: "80分未満" },
  around90: { label: "90分前後" },
  around120: { label: "120分前後" },
  long: { label: "140分以上" },
  unknown: { label: "時間不明" }
};

const sampleItems = [
  {
    id: "sample-1",
    title: "雨の日に観たいサスペンス",
    runtime: 96,
    year: 2019,
    genres: ["サスペンス", "洋画"],
    tags: ["雨の日"],
    note: "サンプル作品です。JSONを読み込むと置き換わります。",
    service: "unext",
    serviceName: "U-NEXT",
    watched: false,
    favorite: true,
    url: "https://video.unext.jp/",
    access: "見放題"
  },
  {
    id: "sample-2",
    title: "週末の長編ドラマ",
    runtime: 128,
    year: 2022,
    genres: ["ドラマ"],
    tags: ["週末"],
    service: "netflix",
    serviceName: "Netflix",
    watched: false,
    favorite: false,
    url: "https://video.unext.jp/",
    access: "見放題"
  }
];

const filters = {
  query: $("#query"),
  mediaType: $("#mediaType"),
  service: $("#service"),
  genre: $("#genre"),
  duration: $("#duration"),
  maxMinutes: $("#maxMinutes"),
  watchState: $("#watchState"),
  sort: $("#sort")
};

function normalizeList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,、]/);
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))];
}

function normalizeItem(item, index) {
  const runtime = Number(item.runtime);
  const year = Number(item.year);
  return {
    watched: false,
    favorite: false,
    hidden: false,
    tags: [],
    genres: [],
    addedOrder: index,
    access: "",
    image: "",
    note: "",
    description: "",
    url: "",
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

function searchable(item) {
  return [item.title, item.note, item.description, ...(item.tags || []), ...(item.genres || [])]
    .join(" ")
    .toLocaleLowerCase("ja");
}

function matches(item) {
  const query = filters.query.value.trim().toLocaleLowerCase("ja");
  if (query && !searchable(item).includes(query)) return false;
  if (filters.mediaType.value && (item.mediaType || "unknown") !== filters.mediaType.value) return false;
  if (filters.service.value && serviceKey(item) !== filters.service.value) return false;
  if (filters.genre.value && !(item.genres || []).includes(filters.genre.value)) return false;
  if (filters.duration.value && durationKey(item.runtime) !== filters.duration.value) return false;
  const limit = Number(filters.maxMinutes.value);
  if (limit && (!Number.isFinite(item.runtime) || item.runtime > limit)) return false;
  if (filters.watchState.value === "unwatched" && item.watched) return false;
  if (filters.watchState.value === "watched" && !item.watched) return false;
  if (filters.watchState.value === "favorite" && !item.favorite) return false;
  return !item.hidden;
}

function sorter(key) {
  const runtimeValue = (item) => Number.isFinite(item.runtime) ? item.runtime : Number.MAX_SAFE_INTEGER;
  if (key === "title") return (a, b) => a.title.localeCompare(b.title, "ja");
  if (key === "runtimeAsc") return (a, b) => runtimeValue(a) - runtimeValue(b);
  if (key === "runtimeDesc") return (a, b) => (b.runtime || -1) - (a.runtime || -1);
  if (key === "yearDesc") return (a, b) => (b.year || 0) - (a.year || 0);
  if (key === "expiry") return (a, b) => (Date.parse(a.expiresAt) || Infinity) - (Date.parse(b.expiresAt) || Infinity);
  if (key === "ratingDesc") return (a, b) => (b.rating || -1) - (a.rating || -1);
  if (key === "backlog") return (a, b) => (Date.parse(a.importedAt) || 0) - (Date.parse(b.importedAt) || 0);
  return (a, b) => (a.addedOrder ?? 999999) - (b.addedOrder ?? 999999);
}

function daysUntil(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}

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
  render();
  GistSync.scheduleSync();
}

function updateGenreOptions() {
  const selected = filters.genre.value;
  const genres = [...new Set(state.items.flatMap((item) => item.genres || []))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  filters.genre.replaceChildren(new Option("すべて", ""));
  genres.forEach((genre) => filters.genre.add(new Option(genre, genre)));
  if ([...filters.genre.options].some((option) => option.value === selected)) filters.genre.value = selected;
}

function updateServiceOptions() {
  const selected = filters.service.value;
  const entries = [...new Set(state.items.map(serviceKey))]
    .sort((a, b) => serviceLabel(a).localeCompare(serviceLabel(b), "ja"));
  filters.service.replaceChildren(new Option("すべて", ""));
  entries.forEach((key) => filters.service.add(new Option(serviceLabel(key), key)));
  if ([...filters.service.options].some((option) => option.value === selected)) filters.service.value = selected;
}

function updateQuickFilters() {
  document.querySelectorAll(".quick-filter").forEach((button) => {
    const control = filters[button.dataset.filter];
    button.classList.toggle("is-active", control?.value === button.dataset.value);
  });
}

function updateFilterSummary() {
  const parts = [];
  if (filters.mediaType.value) parts.push(mediaLabels[filters.mediaType.value] || "");
  const watchLabel = filters.watchState.selectedOptions[0]?.textContent;
  const durationLabel = filters.duration.selectedOptions[0]?.textContent;
  const serviceLabelText = filters.service.selectedOptions[0]?.textContent;
  if (watchLabel) parts.push(watchLabel);
  if (serviceLabelText && serviceLabelText !== "すべて") parts.push(serviceLabelText);
  if (filters.genre.value) parts.push(filters.genre.value);
  if (durationLabel && durationLabel !== "すべて") parts.push(durationLabel);
  const limit = Number(filters.maxMinutes.value);
  if (limit) parts.push(`〜${limit}分`);
  if (filters.query.value.trim()) parts.push("検索中");
  $("#filterSummary").textContent = parts.join("・") || "すべて";
}

function createCard(item) {
  const card = $("#cardTemplate").content.firstElementChild.cloneNode(true);
  card.classList.toggle("is-watched", Boolean(item.watched));
  const poster = $(".poster", card);
  const primaryImage = item.imageLocked
    ? item.image
    : (serviceKey(item) === "prime" && item.tmdbImage) ? item.tmdbImage : (item.image || item.tmdbImage || "");
  if (primaryImage) poster.src = primaryImage;
  poster.alt = item.title ? `${item.title}のポスター` : "";
  poster.addEventListener("error", () => {
    if (item.tmdbImage && poster.src !== item.tmdbImage) poster.src = item.tmdbImage;
    else poster.removeAttribute("src");
  });
  const remaining = item.expiresAt ? daysUntil(item.expiresAt) : null;
  $(".movie-meta", card).textContent = [
    item.mediaType && item.mediaType !== "unknown" ? mediaLabels[item.mediaType] : null,
    serviceLabel(item),
    formatRuntime(item.runtime),
    item.year,
    remaining !== null && remaining <= 30 ? (remaining <= 0 ? "まもなく終了" : `期限あと${remaining}日`) : null,
    item.access
  ].filter(Boolean).join(" · ");
  $("h3", card).textContent = item.title;
  const ratings = $(".ratings", card);
  const addScore = (className, text) => {
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    ratings.append(span);
  };
  if (item.rating) addScore("score-tmdb", `★ ${item.rating}`);
  if (item.imdbRating) addScore("score-imdb", `IMDb ${item.imdbRating}`);
  if (item.rtScore) addScore("score-rt", `🍅 ${item.rtScore}%`);

  const chips = $(".chips", card);
  [...(item.genres || []).slice(0, 2), ...(item.tags || []).slice(0, 1)].forEach((label) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = label;
    chips.append(chip);
  });

  const watched = $(".watched-button", card);
  watched.textContent = item.watched ? "戻す" : "観た";
  watched.addEventListener("click", () => patchItem(item.id, { watched: !item.watched }));

  const favorite = $(".favorite-button", card);
  favorite.textContent = item.favorite ? "★" : "☆";
  favorite.classList.toggle("is-active", Boolean(item.favorite));
  favorite.addEventListener("click", () => patchItem(item.id, { favorite: !item.favorite }));

  $(".trailer-button", card).addEventListener("click", () => openTrailer(item));
  $(".detail-button", card).addEventListener("click", () => openDetail(item));
  const link = $(".watch-link", card);
  link.href = item.url || "https://video.unext.jp/";
  return card;
}

// 予告編: PC側の補完で取得済みのYouTubeキーを再生。なければYouTube検索へ
function openTrailer(item) {
  if (!item.trailerKey) {
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} 予告編`)}`, "_blank", "noreferrer");
    return;
  }
  $("#trailerTitle").textContent = item.title;
  $("#trailerFrame").src = `https://www.youtube-nocookie.com/embed/${item.trailerKey}?autoplay=1&playsinline=1`;
  $("#trailerDialog").showModal();
}

function render() {
  updateServiceOptions();
  updateGenreOptions();
  state.filtered = state.items.filter(matches).sort(sorter(filters.sort.value));
  updateFilterSummary();
  updateQuickFilters();

  const library = $("#library");
  library.replaceChildren();
  state.filtered.forEach((item) => library.append(createCard(item)));

  const runtimes = state.items.map((item) => item.runtime).filter(Number.isFinite);
  $("#totalCount").textContent = state.items.length;
  $("#unwatchedCount").textContent = state.items.filter((item) => !item.watched).length;
  $("#averageRuntime").textContent = runtimes.length ? `${Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length)}分` : "-";
  $("#filteredCount").textContent = `${state.filtered.length}件`;
  $("#resultsTitle").textContent = filters.watchState.value === "unwatched" ? "未視聴の作品" : "該当する作品";
  $("#importPanel").classList.toggle("is-hidden", state.items.length > 0);
  $("#empty").hidden = state.filtered.length > 0;
  if (!state.filtered.length && state.items.length) {
    $("#empty h2").textContent = "条件に合う作品がありません";
    $("#empty p").textContent = "絞り込み条件を変えてみてください。";
  } else if (!state.items.length) {
    $("#empty h2").textContent = "まだ作品がありません";
    $("#empty p").textContent = "PCの拡張機能からJSONを書き出して、この画面で読み込んでください。";
  }
}

function openDetail(item) {
  const content = $("#detailContent");
  content.replaceChildren();
  if (item.image) {
    const image = document.createElement("img");
    image.src = item.image;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    content.append(image);
  }
  const heading = document.createElement("h2");
  heading.textContent = item.title;
  const meta = document.createElement("p");
  meta.textContent = [serviceLabel(item), formatRuntime(item.runtime), item.year, ...(item.genres || [])].filter(Boolean).join(" · ");
  const note = document.createElement("p");
  note.textContent = item.note || item.description || "メモはまだありません。";
  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "閉じる";
  close.addEventListener("click", () => $("#detailDialog").close());
  const trailer = document.createElement("button");
  trailer.type = "button";
  trailer.textContent = "▶ 予告編";
  trailer.addEventListener("click", () => openTrailer(item));
  const watch = document.createElement("a");
  watch.href = item.url || "https://video.unext.jp/";
  watch.target = "_blank";
  watch.rel = "noreferrer";
  watch.textContent = `${serviceLabel(item)}で開く`;
  actions.append(close, trailer, watch);
  content.append(heading, meta, note, actions);
  $("#detailDialog").showModal();
}

function loadStoredItems() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey) || "[]");
    state.items = Array.isArray(stored) ? stored.map(normalizeItem) : [];
  } catch {
    state.items = [];
  }
  try {
    const deleted = JSON.parse(localStorage.getItem(deletedKey) || "{}");
    state.deleted = deleted && typeof deleted === "object" && !Array.isArray(deleted) ? deleted : {};
  } catch {
    state.deleted = {};
  }
  render();
}

// GitHub Gistとの双方向同期。拡張機能側のsync.jsと同じマージ規則を使う。
const GistSync = (() => {
  const GIST_API = "https://api.github.com/gists";
  const GIST_FILE = "mylist.json";
  const STATE_FIELDS = ["watched", "favorite", "hidden", "tags", "note"];
  let pushTimer = null;
  let syncing = false;

  const metaStamp = (item) => Date.parse(item?.updatedAt || item?.lastCheckedAt || item?.importedAt || "") || 0;
  const stateStamp = (item) => Date.parse(item?.stateUpdatedAt || "") || 0;

  function getConfig() {
    try {
      const config = JSON.parse(localStorage.getItem(syncConfigKey) || "{}");
      return config && typeof config === "object" ? config : {};
    } catch {
      return {};
    }
  }

  function setConfig(config) {
    localStorage.setItem(syncConfigKey, JSON.stringify(config));
  }

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
    for (const field of STATE_FIELDS) {
      if (field in stateSource) merged[field] = stateSource[field];
    }
    if (stateSource.stateUpdatedAt) merged.stateUpdatedAt = stateSource.stateUpdatedAt;
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
      if (item && metaStamp(item) <= (Date.parse(at) || 0) && stateStamp(item) <= (Date.parse(at) || 0)) map.delete(id);
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
      render();
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
  render();
  GistSync.scheduleSync();
}

Object.values(filters).forEach((control) => control.addEventListener("input", render));

document.querySelectorAll(".quick-filter").forEach((button) => {
  button.addEventListener("click", () => {
    const control = filters[button.dataset.filter];
    if (!control) return;
    control.value = control.value === button.dataset.value ? "" : button.dataset.value;
    render();
  });
});

$("#importJson").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await importFile(file);
  } catch (error) {
    alert(`読み込めませんでした: ${error.message}`);
  } finally {
    event.target.value = "";
  }
});

$("#exportJson").addEventListener("click", () => {
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `unext-mylist-mobile-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("#clearFilters").addEventListener("click", () => {
  filters.query.value = "";
  filters.mediaType.value = "";
  filters.service.value = "";
  filters.genre.value = "";
  filters.duration.value = "";
  filters.watchState.value = "unwatched";
  filters.sort.value = "added";
  render();
});

$("#clearAll").addEventListener("click", () => {
  if (!confirm("この端末に保存した作品データを削除しますか？（同期先のデータは残り、次回同期で戻ります）")) return;
  state.items = [];
  saveItems();
  render();
});

$("#syncButton").addEventListener("click", () => {
  const config = GistSync.getConfig();
  $("#syncToken").value = config.token || "";
  $("#syncGistId").value = config.gistId || "";
  $("#syncDialog").showModal();
});

$("#syncCancel").addEventListener("click", () => $("#syncDialog").close());

$("#syncForm").addEventListener("submit", (event) => {
  event.preventDefault();
  GistSync.setConfig({ token: $("#syncToken").value.trim(), gistId: $("#syncGistId").value.trim() });
  $("#syncDialog").close();
  GistSync.syncNow();
});

$("#syncDialog").addEventListener("click", (event) => {
  if (event.target === $("#syncDialog")) $("#syncDialog").close();
});

$("#pickButton").addEventListener("click", () => {
  if (!state.filtered.length) return alert("現在の条件に合う作品がありません。");
  const item = state.filtered[Math.floor(Math.random() * state.filtered.length)];
  openDetail(item);
});

$("#loadSample").addEventListener("click", () => {
  state.items = sampleItems.map(normalizeItem);
  saveItems();
  render();
});

$("#detailDialog").addEventListener("click", (event) => {
  if (event.target === $("#detailDialog")) $("#detailDialog").close();
});

$("#trailerClose").addEventListener("click", () => $("#trailerDialog").close());
$("#trailerDialog").addEventListener("close", () => { $("#trailerFrame").src = ""; });
$("#trailerDialog").addEventListener("click", (event) => {
  if (event.target === $("#trailerDialog")) $("#trailerDialog").close();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadStoredItems();
GistSync.syncNow();
