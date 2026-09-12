/**
 * @name Auto Source Select
 * @description Waits for the configured addons to answer on a streams page, ranks
 *              the streams against auto-source-select.config.js, shows a countdown
 *              toast naming the pick and plays it unless cancelled.
 * @version 1.0.0
 *
 * Config lives in portable_config/webmods/auto-source-select.config.js (injected
 * before this file, read lazily here). The on/off toggle in Settings is
 * localStorage "kai-auto-source-enabled" (Settings/auto-source-settings.js).
 *
 * Only forward navigation triggers a pick: arriving from the detail page, the
 * episode list, Continue Watching or a binge-next-episode landing. Backing out
 * of the player onto the same video, or a video the user cancelled earlier this
 * session, stays quiet.
 */

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.AutoSourceSelect?.initialized) return;

  const ENABLED_STORAGE = "kai-auto-source-enabled";
  const DISMISSED_STORAGE = "kai-auto-source-dismissed";
  const TOAST_CLASS = "kai-auto-source-toast";
  const PICK_CLASS = "kai-auto-source-pick";
  const STREAMS_RE = /^#\/detail\/([^\/]+)\/([^\/]+)\/([^\/?]+)/;
  const TICK_MS = 250;

  const DEFAULTS = {
    enabled: true,
    debug: false,
    maxWaitSeconds: 15,
    settleSeconds: 1.5,
    idleSeconds: 5,
    countdownSeconds: 5,
    priority: ["addon", "quality", "language", "size"],
    addons: [
      { name: "Torrentio TB+", addon: /^Torrentio TB$/i, match: /^\[TB\+\]\s*Torrentio/i },
      { name: "Torrentio AD+", addon: /^Torrentio AD$/i, match: /^\[AD\+\]\s*Torrentio/i },
      { name: "Jackettio TB⚡", addon: /^Jackettio/i, match: /^\[TB⚡\]\s*Jackettio/i },
    ],
    quality: ["1080p", "4K", "720p"],
    languages: [
      { name: "Malayalam", flags: [], keywords: ["mal", "malayalam"] },
      { name: "English", flags: ["🇬🇧", "🇺🇸"], keywords: ["eng", "english"] },
      { name: "Hindi", flags: [], keywords: ["hin", "hindi"] },
    ],
    unknownLanguageAs: "English",
    maxSizeGB: 20,
    idealSizeGB: { movie: [2, 3.5], series: [0, 1.5] },
    excludeKeywords: [/\btrailer\b/i, /\bsample\b/i, /\b(cam|hdcam|camrip|hdts|telesync|telecine)\b/i],
    preferFirst: [],
  };

  // ───────────────────────────────────────────────────────────────────────────
  // CONFIG
  // ───────────────────────────────────────────────────────────────────────────
  function configLoaded() {
    const c = window.__autoSourceSelectConfig;
    return !!c && typeof c === "object";
  }

  function getConfig() {
    const user = configLoaded() ? window.__autoSourceSelectConfig : {};
    const cfg = Object.assign({}, DEFAULTS, user);
    cfg.idealSizeGB = Object.assign({}, DEFAULTS.idealSizeGB, user.idealSizeGB || {});
    for (const k of ["priority", "addons", "quality", "languages", "excludeKeywords", "preferFirst"]) {
      if (!Array.isArray(cfg[k])) cfg[k] = DEFAULTS[k];
    }
    return cfg;
  }

  function isEnabled(cfg) {
    try {
      if (localStorage.getItem(ENABLED_STORAGE) === "false") return false;
    } catch (_) {}
    return configLoaded() && cfg.enabled === true;
  }

  function log(...args) {
    console.log("[Auto Source]", ...args);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROUTES
  // ───────────────────────────────────────────────────────────────────────────
  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  // #/detail/<type>/<id>/<videoId>
  function parseStreamsHash(hash) {
    const m = STREAMS_RE.exec(hash || "");
    if (!m) return null;
    const type = m[1];
    const id = decode(m[2]);
    const videoId = decode(m[3]);
    return { type, id, videoId, key: type + "/" + id + "/" + videoId };
  }

  // #/player/<stream>/<streamTransport>/<metaTransport>/<type>/<id>/<videoId>
  // Short forms (YouTube, external) have no video key.
  function parsePlayerHash(hash) {
    if (!/^#\/player\//.test(hash || "")) return null;
    const parts = hash.split("?")[0].split("/");
    if (parts.length < 7) return { key: null };
    const type = parts[4];
    const id = decode(parts[5]);
    const videoId = decode(parts[6]);
    return { key: type + "/" + id + "/" + videoId };
  }

  function dismissedSet() {
    try {
      const raw = sessionStorage.getItem(DISMISSED_STORAGE);
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
      return new Set();
    }
  }

  function markDismissed(key) {
    try {
      const set = dismissedSet();
      set.add(key);
      sessionStorage.setItem(DISMISSED_STORAGE, JSON.stringify([...set]));
    } catch (_) {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DOM
  // ───────────────────────────────────────────────────────────────────────────
  // The list re-renders its container when the first stream arrives (placeholder
  // skeletons live in a different element), so this is resolved on every tick.
  function findContainer() {
    const containers = document.querySelectorAll('[class*="streams-container"]');
    for (const c of containers) {
      if (c.closest('[class*="select-choices"]')) continue;
      if (c.closest('[class*="multiselect"]')) continue;
      if (c.closest('[class*="streams-list"]')) return c;
    }
    return null;
  }

  function getRows(container) {
    if (!container) return [];
    return Array.from(container.querySelectorAll(':scope > a[href^="#/player/"]'));
  }

  function listState() {
    const container = findContainer();
    const listRoot = container ? container.closest('[class*="streams-list"]') : null;
    const loadingEl = listRoot ? listRoot.querySelector('[class*="addons-loading"]') : null;
    const placeholders = container ? container.querySelector('[class*="placeholder"]') : null;
    return {
      container,
      rows: getRows(container),
      loadingText: loadingEl ? loadingEl.textContent.trim() : "",
      allAnswered: !!container && !loadingEl && !placeholders,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PARSING
  // ───────────────────────────────────────────────────────────────────────────
  const SIZE_RE = /💾\s*([\d.,]+)\s*(TB|GB|MB|KB)/i;
  const SEEDERS_RE = /(?:👤|👥)\s*(\d+)/u;
  const FLAG_RE = /\p{Regional_Indicator}{2}/gu;
  const RES_RE = /\b(\d{3,4})p\b/i;

  function parseSizeGB(text) {
    const m = SIZE_RE.exec(text);
    if (!m) return null;
    const n = parseFloat(m[1].replace(",", "."));
    if (!isFinite(n)) return null;
    switch (m[2].toUpperCase()) {
      case "TB": return n * 1024;
      case "GB": return n;
      case "MB": return n / 1024;
      case "KB": return n / (1024 * 1024);
    }
    return null;
  }

  function parseQuality(text) {
    if (/\b(2160p|4k|uhd)\b/i.test(text)) return { tier: "4K", resPx: 2160 };
    if (/\b1080p\b/i.test(text)) return { tier: "1080p", resPx: 1080 };
    if (/\b720p\b/i.test(text)) return { tier: "720p", resPx: 720 };
    const m = RES_RE.exec(text);
    const px = m ? parseInt(m[1], 10) : 0;
    return { tier: px ? px + "p" : "unknown", resPx: px };
  }

  function parseRow(a, index) {
    const addonTitle = a.getAttribute("title") || "";
    // The wrapper div's title carries the full multi-line stream name and is the
    // only source when the row shows a thumbnail instead of the name.
    const nameEl = a.querySelector('[class*="info-container"] > div[title]');
    const name =
      (nameEl && nameEl.getAttribute("title")) ||
      (a.querySelector('[class*="addon-name"]') || {}).textContent ||
      "";
    const nameLines = name.split("\n").map((s) => s.trim()).filter(Boolean);
    const descEl = a.querySelector('[class*="description-container"]');
    const desc = descEl ? descEl.getAttribute("title") || descEl.textContent || "" : "";
    const descLines = desc.split("\n").map((s) => s.trim()).filter(Boolean);
    const title = descLines[0] || "";
    const meta = descLines.slice(1).join(" ");
    const q = parseQuality(nameLines.slice(1).join(" ") + " " + title);
    const seeders = SEEDERS_RE.exec(meta);
    return {
      index,
      href: a.getAttribute("href"),
      hidden: a.dataset.streamFilterHidden === "1",
      addonTitle,
      nameLine: nameLines[0] || "",
      qualityLine: nameLines[1] || "",
      title,
      meta,
      sizeGB: parseSizeGB(meta),
      seeders: seeders ? parseInt(seeders[1], 10) : 0,
      flags: Array.from(meta.matchAll(FLAG_RE), (m) => m[0]),
      quality: q.tier,
      resPx: q.resPx,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RANKING
  // ───────────────────────────────────────────────────────────────────────────
  function toRegex(v, flags) {
    if (v instanceof RegExp) return v;
    if (typeof v !== "string" || !v) return null;
    return new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags || "i");
  }

  function keywordRegex(keywords) {
    const parts = [];
    for (const k of keywords || []) {
      if (k instanceof RegExp) parts.push(k.source);
      else if (typeof k === "string" && k) parts.push(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    return parts.length ? new RegExp("(?:^|[^\\p{L}\\p{N}])(?:" + parts.join("|") + ")(?![\\p{L}\\p{N}])", "iu") : null;
  }

  function matchAddon(cfg, row) {
    for (let i = 0; i < cfg.addons.length; i++) {
      const re = toRegex(cfg.addons[i].match);
      if (re && re.test(row.nameLine)) return i;
    }
    return cfg.addons.length ? -1 : 0;
  }

  function matchLanguage(cfg, row) {
    for (let i = 0; i < cfg.languages.length; i++) {
      const entry = cfg.languages[i];
      const flags = Array.isArray(entry.flags) ? entry.flags : [];
      if (flags.some((f) => row.flags.includes(f))) return i;
      const re = keywordRegex(entry.keywords);
      if (re && re.test(row.title)) return i;
    }
    if (row.flags.length === 0 && cfg.unknownLanguageAs) {
      const i = cfg.languages.findIndex((l) => l.name === cfg.unknownLanguageAs);
      if (i >= 0) return i;
    }
    return cfg.languages.length;
  }

  function qualityRank(cfg, tier) {
    const i = cfg.quality.findIndex((q) => String(q).toLowerCase() === tier.toLowerCase());
    return i >= 0 ? i : cfg.quality.length;
  }

  function sizeInfo(cfg, type, sizeGB) {
    const range = cfg.idealSizeGB[type] || cfg.idealSizeGB.movie;
    if (!Array.isArray(range) || range.length < 2) return { rank: 0, dist: 0 };
    if (sizeGB == null) return { rank: 1, dist: Infinity };
    const [lo, hi] = range;
    if (sizeGB >= lo && sizeGB <= hi) return { rank: 0, dist: 0 };
    return { rank: 1, dist: sizeGB < lo ? lo - sizeGB : sizeGB - hi };
  }

  function excluded(cfg, row) {
    return cfg.excludeKeywords.some((k) => {
      const re = toRegex(k);
      return re && re.test(row.title);
    });
  }

  function score(cfg, type, row) {
    const addonRank = matchAddon(cfg, row);
    const langRank = matchLanguage(cfg, row);
    const size = sizeInfo(cfg, type, row.sizeGB);
    return Object.assign(row, {
      addonRank,
      addonName: addonRank >= 0 && cfg.addons[addonRank] ? cfg.addons[addonRank].name : null,
      qualityRank: qualityRank(cfg, row.quality),
      langRank,
      language: cfg.languages[langRank] ? cfg.languages[langRank].name : null,
      sizeRank: size.rank,
      sizeDist: size.dist,
    });
  }

  const RANK_FIELD = {
    addon: "addonRank",
    quality: "qualityRank",
    language: "langRank",
    size: "sizeRank",
  };

  function comparator(priority) {
    const fields = (priority || [])
      .map((p) => RANK_FIELD[String(p).toLowerCase()])
      .filter(Boolean);
    return (a, b) => {
      for (const f of fields) {
        if (a[f] !== b[f]) return a[f] - b[f];
      }
      if (a.sizeDist !== b.sizeDist) return a.sizeDist - b.sizeDist;
      if (a.resPx !== b.resPx) return b.resPx - a.resPx;
      if (a.seeders !== b.seeders) return b.seeders - a.seeders;
      return a.index - b.index;
    };
  }

  function ruleAccepts(rule, c) {
    if (!rule || typeof rule !== "object") return false;
    if (Array.isArray(rule.addons) && !rule.addons.includes(c.addonName)) return false;
    if (
      Array.isArray(rule.quality) &&
      !rule.quality.some((q) => String(q).toLowerCase() === c.quality.toLowerCase())
    )
      return false;
    if (Array.isArray(rule.languages) && !rule.languages.includes(c.language)) return false;
    if (typeof rule.minSizeGB === "number" && !(c.sizeGB != null && c.sizeGB >= rule.minSizeGB)) return false;
    if (typeof rule.maxSizeGB === "number" && !(c.sizeGB != null && c.sizeGB <= rule.maxSizeGB)) return false;
    if (typeof rule.minSeeders === "number" && c.seeders < rule.minSeeders) return false;
    if (rule.match) {
      const re = toRegex(rule.match);
      if (re && !re.test(c.title)) return false;
    }
    return true;
  }

  function rank(cfg, type, rows) {
    const rejected = [];
    const pool = [];
    rows.forEach((a, i) => {
      const row = score(cfg, type, parseRow(a, i));
      let why = null;
      if (row.hidden) why = "hidden by filter";
      else if (row.addonRank < 0) why = "addon not configured";
      else if (excluded(cfg, row)) why = "excluded keyword";
      else if (typeof cfg.maxSizeGB === "number" && row.sizeGB != null && row.sizeGB > cfg.maxSizeGB)
        why = "over size cap";
      if (why) rejected.push(Object.assign(row, { rejected: why }));
      else pool.push(row);
    });

    let ruleIndex = -1;
    let ranked = pool.slice().sort(comparator(cfg.priority));
    for (let i = 0; i < cfg.preferFirst.length; i++) {
      const rule = cfg.preferFirst[i];
      const subset = pool.filter((c) => ruleAccepts(rule, c));
      if (subset.length) {
        ruleIndex = i;
        ranked = subset.sort(comparator(Array.isArray(rule.priority) ? rule.priority : cfg.priority));
        break;
      }
    }
    return { pick: ranked[0] || null, ranked, pool, rejected, ruleIndex };
  }

  function describe(c) {
    const bits = [c.addonName || c.nameLine, c.quality];
    if (c.sizeGB != null) bits.push(c.sizeGB >= 1 ? c.sizeGB.toFixed(2) + " GB" : Math.round(c.sizeGB * 1024) + " MB");
    if (c.flags.length) bits.push(c.flags.join(" "));
    if (c.language && c.language !== "Rest") bits.push(c.language);
    return bits.join(" · ");
  }

  function logRanking(result) {
    const cols = (c) => ({
      pick: describe(c),
      title: c.title,
      addon: c.addonRank,
      quality: c.qualityRank,
      lang: c.langRank,
      size: c.sizeRank,
      dist: c.sizeDist === Infinity ? "?" : +c.sizeDist.toFixed(2),
      seeders: c.seeders,
    });
    if (result.ruleIndex >= 0) log("preferFirst rule #" + result.ruleIndex + " matched");
    log("ranked " + result.ranked.length + " / pool " + result.pool.length + " / rejected " + result.rejected.length);
    if (console.table) console.table(result.ranked.slice(0, 15).map(cols));
    else log(result.ranked.slice(0, 15).map(cols));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TOAST
  // ───────────────────────────────────────────────────────────────────────────
  let toastEl = null;
  let toastTimer = null;

  function removeToast() {
    if (toastTimer) clearInterval(toastTimer);
    toastTimer = null;
    if (toastEl) toastEl.remove();
    toastEl = null;
    document.querySelectorAll("." + PICK_CLASS).forEach((el) => el.classList.remove(PICK_CLASS));
  }

  function button(label, primary, onActivate) {
    const b = document.createElement("div");
    b.tabIndex = 0;
    b.className = "button-container-zVLH6 kai-ass-btn" + (primary ? " kai-ass-primary" : "");
    b.textContent = label;
    b.addEventListener("click", onActivate);
    // Gamepad "A" arrives as a synthetic Enter keydown on the focused element.
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.keyCode === 13) {
        e.preventDefault();
        e.stopPropagation();
        onActivate();
      }
    });
    return b;
  }

  function baseToast(kind) {
    removeToast();
    toastEl = document.createElement("div");
    toastEl.className = TOAST_CLASS + " kai-ass-" + kind;
    toastEl.setAttribute("role", "dialog");
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function infoToast(text, ms) {
    const el = baseToast("info");
    el.innerHTML = '<div class="kai-ass-head"><span class="kai-ass-title">Auto-select</span><span class="kai-ass-count"></span></div>';
    el.querySelector(".kai-ass-count").textContent = text;
    setTimeout(() => {
      if (toastEl === el) removeToast();
    }, ms || 3000);
  }

  function findRowByHref(href) {
    const container = findContainer();
    if (!container || !href) return null;
    const esc = window.CSS && CSS.escape ? CSS.escape(href) : href.replace(/"/g, '\\"');
    return container.querySelector(':scope > a[href="' + esc + '"]');
  }

  // Rows are re-keyed when a slower addon's streams get inserted above ours, so
  // the pick is tracked by href rather than by element.
  function highlight(href) {
    const row = findRowByHref(href);
    if (!row) return null;
    if (!row.classList.contains(PICK_CLASS)) {
      document.querySelectorAll("." + PICK_CLASS).forEach((el) => el.classList.remove(PICK_CLASS));
      row.classList.add(PICK_CLASS);
    }
    return row;
  }

  function play(pick) {
    const row = findRowByHref(pick.href);
    removeToast();
    if (row) row.click();
    else window.location.href = pick.href;
  }

  function showCountdown(session, pick, cfg) {
    const seconds = Math.max(0, Number(cfg.countdownSeconds) || 0);
    const el = baseToast("pick");
    el.innerHTML =
      '<div class="kai-ass-head"><span class="kai-ass-title">Auto-select</span><span class="kai-ass-count"></span></div>' +
      '<div class="kai-ass-bar"><div class="kai-ass-bar-fill"></div></div>' +
      '<div class="kai-ass-meta"></div>' +
      '<div class="kai-ass-name"></div>' +
      '<div class="kai-ass-buttons"></div>';
    el.querySelector(".kai-ass-meta").textContent = describe(pick);
    el.querySelector(".kai-ass-name").textContent = pick.title;
    el.querySelector(".kai-ass-name").title = pick.title;
    const count = el.querySelector(".kai-ass-count");
    const fill = el.querySelector(".kai-ass-bar-fill");
    const buttons = el.querySelector(".kai-ass-buttons");

    const row = highlight(pick.href);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "center", behavior: "smooth" });

    if (seconds === 0) {
      count.textContent = "playing…";
      fill.style.width = "0%";
      play(pick);
      return;
    }

    const cancel = button("Cancel", false, () => {
      markDismissed(session.key);
      session.done = true;
      if (toastTimer) clearInterval(toastTimer);
      toastTimer = null;
      count.textContent = "cancelled";
      fill.style.width = "0%";
      buttons.remove();
      document.querySelectorAll("." + PICK_CLASS).forEach((x) => x.classList.remove(PICK_CLASS));
      setTimeout(() => {
        if (toastEl === el) removeToast();
      }, 1500);
    });
    const playNow = button("Play now", true, () => play(pick));
    buttons.appendChild(cancel);
    buttons.appendChild(playNow);
    cancel.focus({ preventScroll: true });

    const startedAt = Date.now();
    const total = seconds * 1000;
    const update = () => {
      const left = Math.max(0, total - (Date.now() - startedAt));
      count.textContent = "playing in " + Math.ceil(left / 1000) + "s";
      fill.style.width = (left / total) * 100 + "%";
      highlight(pick.href);
      if (left <= 0) {
        clearInterval(toastTimer);
        toastTimer = null;
        play(pick);
      }
    };
    update();
    toastTimer = setInterval(update, 100);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SESSION (one per streams page visit)
  // ───────────────────────────────────────────────────────────────────────────
  let session = null;

  function endSession() {
    if (!session) return;
    clearInterval(session.timer);
    session.observer?.disconnect();
    session = null;
    removeToast();
  }

  function startSession(route, cfg) {
    endSession();
    const now = Date.now();
    session = {
      key: route.key,
      type: route.type,
      cfg,
      startedAt: now,
      lastRows: -1,
      lastLoading: null,
      lastChangeAt: now,
      done: false,
      timer: null,
      observer: null,
    };
    session.timer = setInterval(tick, TICK_MS);

    let debounce = null;
    session.observer = new MutationObserver((muts) => {
      if (muts.every((m) => m.target?.closest?.("." + TOAST_CLASS))) return;
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        tick();
      }, 100);
    });
    session.observer.observe(document.body, { childList: true, subtree: true });
    if (cfg.debug) log("session started for " + route.key);
    tick();
  }

  function addonHasRows(entry, rows) {
    const re = toRegex(entry.addon);
    if (!re) return true;
    return rows.some((a) => re.test(a.getAttribute("title") || ""));
  }

  function tick() {
    if (!session || session.done) return;
    const s = session;
    const cfg = s.cfg;
    const now = Date.now();
    const state = listState();

    if (state.rows.length !== s.lastRows || state.loadingText !== s.lastLoading) {
      s.lastRows = state.rows.length;
      s.lastLoading = state.loadingText;
      s.lastChangeAt = now;
    }
    const quietMs = now - s.lastChangeAt;
    const elapsedMs = now - s.startedAt;

    let reason = null;
    if (state.allAnswered) {
      reason = "all addons answered";
    } else if (
      state.rows.length > 0 &&
      cfg.addons.every((e) => addonHasRows(e, state.rows)) &&
      quietMs >= cfg.settleSeconds * 1000
    ) {
      reason = "configured addons answered and list settled";
    } else if (
      cfg.idleSeconds > 0 &&
      state.rows.length > 0 &&
      (!cfg.addons.length || addonHasRows(cfg.addons[0], state.rows)) &&
      quietMs >= cfg.idleSeconds * 1000
    ) {
      reason = "list idle";
    } else if (elapsedMs >= cfg.maxWaitSeconds * 1000) {
      reason = "max wait reached";
    }
    if (!reason) return;

    s.done = true;
    clearInterval(s.timer);
    s.observer?.disconnect();

    const result = rank(cfg, s.type, state.rows);
    if (cfg.debug) {
      log("deciding: " + reason + " after " + (elapsedMs / 1000).toFixed(1) + "s");
      logRanking(result);
    }
    if (!result.pick) {
      infoToast("no stream matched your config", 3000);
      return;
    }
    showCountdown(s, result.pick, cfg);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROUTING
  // ───────────────────────────────────────────────────────────────────────────
  function onRoute(newHash, oldHash) {
    endSession();

    const route = parseStreamsHash(newHash);
    if (!route) return;

    const cfg = getConfig();
    if (!isEnabled(cfg)) return;

    const from = parsePlayerHash(oldHash);
    if (from && from.key === route.key) {
      if (cfg.debug) log("skip: back from player");
      return;
    }
    if (dismissedSet().has(route.key)) {
      if (cfg.debug) log("skip: cancelled earlier this session");
      return;
    }
    startSession(route, cfg);
  }

  function dryRun() {
    const cfg = getConfig();
    const route = parseStreamsHash(window.location.hash);
    if (!route) {
      log("not on a streams page");
      return null;
    }
    const state = listState();
    const result = rank(cfg, route.type, state.rows);
    log("config loaded: " + configLoaded() + ", enabled: " + isEnabled(cfg) +
        ", rows: " + state.rows.length + ", all answered: " + state.allAnswered +
        (state.loadingText ? " (" + state.loadingText + ")" : ""));
    logRanking(result);
    if (result.pick) log("would pick:", describe(result.pick), "-", result.pick.title);
    if (result.rejected.length && console.table) {
      log("rejected:");
      console.table(result.rejected.slice(0, 30).map((c) => ({ why: c.rejected, row: c.nameLine, title: c.title })));
    }
    return result;
  }

  function init() {
    window.addEventListener("hashchange", (e) => {
      let oldHash = "";
      try {
        oldHash = new URL(e.oldURL).hash;
      } catch (_) {}
      onRoute(window.location.hash, oldHash);
    });
    onRoute(window.location.hash, "");
    log("Loaded v1.0.0" + (configLoaded() ? "" : " (config not loaded)"));
  }

  window.AutoSourceSelect = {
    initialized: true,
    dryRun,
    getConfig,
    configLoaded,
    cancel: endSession,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
