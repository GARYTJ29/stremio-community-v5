/**
 * @name Detail Page Ratings
 * @description Adds multi-source ratings (Rotten Tomatoes, Metacritic, TMDB,
 *              Letterboxd, Trakt, MDBList) to Stremio v5 detail pages, on top of
 *              the built-in IMDb rating. Data comes from the MDBList API, which
 *              needs a free personal API key (set it in Settings > Online Ratings).
 * @version 1.0.0
 *
 * Self-contained: no dependency on the Stremio-Kai metadata suite. The companion
 * file Settings/ratings-api-key.js provides the key-entry UI, but this script only
 * reads localStorage, so it works even if that file is absent.
 */

(function () {
  "use strict";

  if (window.KaiDetailRatings?.initialized) return;
  window.KaiDetailRatings = { initialized: true };

  // ───────────────────────────────────────────────────────────────────────────
  // SHARED STORAGE (keys match Stremio-Kai for forward-compatibility)
  // ───────────────────────────────────────────────────────────────────────────
  const KEY_STORAGE = "kai-api-key-mdblist";
  const ENABLED_STORAGE = "kai-detail-ratings-enabled";
  const RL_STORAGE = "kai-api-ratelimit-MDBLIST";

  function getApiKey() {
    try {
      const raw = localStorage.getItem(KEY_STORAGE);
      if (!raw) return null;
      // Stored obfuscated (btoa(encodeURIComponent(key))); tolerate plain text too.
      try {
        return decodeURIComponent(atob(raw)) || null;
      } catch (_) {
        return raw || null;
      }
    } catch (_) {
      return null;
    }
  }

  function isEnabled() {
    try {
      return localStorage.getItem(ENABLED_STORAGE) !== "false";
    } catch (_) {
      return true;
    }
  }

  function isRateLimited() {
    try {
      const until = parseInt(localStorage.getItem(RL_STORAGE) || "0", 10);
      return Number.isFinite(until) && Date.now() < until;
    } catch (_) {
      return false;
    }
  }

  function markRateLimited() {
    try {
      localStorage.setItem(RL_STORAGE, String(Date.now() + 60 * 60 * 1000));
    } catch (_) {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RATING LOGOS + COLOUR HELPERS (adapted from Kai's ratings-utils.js)
  // ───────────────────────────────────────────────────────────────────────────
  const LOGOS = {
    imdb: "https://upload.wikimedia.org/wikipedia/commons/5/57/IMDb_Logo_Rectangle.svg",
    mal: "https://upload.wikimedia.org/wikipedia/commons/9/9b/MyAnimeList_favicon.svg",
    letterboxd:
      "https://a.ltrbxd.com/logos/letterboxd-decal-dots-neg-rgb-500px.png",
    mdblist: "https://mdblist.com/static/mdblist_logo.png",
    metacritic:
      "https://upload.wikimedia.org/wikipedia/commons/f/f2/Metacritic_M.png",
    rtFresh:
      "https://upload.wikimedia.org/wikipedia/commons/5/5b/Rotten_Tomatoes.svg",
    rtRotten:
      "https://upload.wikimedia.org/wikipedia/commons/5/52/Rotten_Tomatoes_rotten.svg",
    rtAudienceFresh:
      "https://upload.wikimedia.org/wikipedia/commons/d/da/Rotten_Tomatoes_positive_audience.svg",
    rtAudienceRotten:
      "https://upload.wikimedia.org/wikipedia/commons/6/63/Rotten_Tomatoes_negative_audience.svg",
    tmdb: "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg",
  };

  const TRAKT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ED1C24" d="M19.178 18.464a9.654 9.654 0 0 0 2.484-6.466c0-3.885-2.287-7.215-5.568-8.76l-6.089 6.076 9.173 9.15zm-6.83-7.393v-.008l-.678-.676 4.788-4.79.679.689-4.789 4.785zm3.863-7.265.677.682-5.517 5.517-.68-.679 5.52-5.52zM4.89 18.531A9.601 9.601 0 0 0 12 21.644a9.618 9.618 0 0 0 4.027-.876l-6.697-6.68-4.44 4.443z"></path><path fill="#ED1C24" d="M12 24c6.615 0 12-5.385 12-12S18.615 0 12 0 0 5.385 0 12s5.385 12 12 12zm0-22.789c5.95 0 10.79 4.839 10.79 10.789S17.95 22.79 12 22.79 1.211 17.95 1.211 12 6.05 1.211 12 1.211z"></path><path fill="#ED1C24" d="m4.276 17.801 5.056-5.055.359.329 7.245 7.245a3.31 3.31 0 0 0 .42-.266L9.33 12.05l-4.854 4.855-.679-.679 5.535-5.535.359.331 8.46 8.437c.135-.1.255-.215.375-.316L9.39 10.027l-.083.015-.006-.007-5.074 5.055-.679-.68L15.115 2.849A9.756 9.756 0 0 0 12 2.34C6.663 2.337 2.337 6.663 2.337 12c0 2.172.713 4.178 1.939 5.801z"></path></svg>`;

  function hslToRgb(h, s, l) {
    h /= 360;
    s /= 100;
    l /= 100;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(
      b * 255,
    )})`;
  }

  function getImdbColor(rating) {
    const n = parseFloat(rating);
    if (!n || n < 0) return "rgb(108, 108, 108)";
    if (n >= 9.0) return "rgb(245, 197, 24)";
    if (n >= 7.0) {
      const p = (9.0 - n) / 2.0;
      return hslToRgb(45, 85 - p * 35, 50 - p * 5);
    }
    if (n >= 5.0) {
      const p = (7.0 - n) / 2.0;
      return hslToRgb(45, 50 - p * 40, 45 - p * 10);
    }
    if (n >= 3.0) {
      const p = (5.0 - n) / 2.0;
      const g = Math.round(184 - p * 38);
      return `rgb(${g}, ${g}, ${g})`;
    }
    const g = Math.round(Math.max(108, 146 - (3.0 - n) * 19));
    return `rgb(${g}, ${g}, ${g})`;
  }

  function metacriticClass(score) {
    const s = parseInt(score, 10);
    if (s >= 60) return "kai-mc-high";
    if (s >= 40) return "kai-mc-medium";
    return "kai-mc-low";
  }

  function mdblistClass(score) {
    if (score >= 80) return "kai-mdb-great";
    if (score >= 60) return "kai-mdb-good";
    if (score >= 40) return "kai-mdb-mixed";
    return "kai-mdb-bad";
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MDBLIST FETCH (direct API, with in-memory + session cache)
  // ───────────────────────────────────────────────────────────────────────────
  const memCache = new Map(); // cacheKey -> normalized ratings object | null

  function sessionGet(cacheKey) {
    try {
      const raw = sessionStorage.getItem("kai-mdblist:" + cacheKey);
      return raw ? JSON.parse(raw) : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function sessionSet(cacheKey, value) {
    try {
      sessionStorage.setItem("kai-mdblist:" + cacheKey, JSON.stringify(value));
    } catch (_) {}
  }

  function normalizeRatings(data) {
    const out = { sources: {}, ids: data.ids || {} };
    const list = Array.isArray(data.ratings) ? data.ratings : [];
    for (const r of list) {
      if (r == null || r.value == null) continue;
      let src = String(r.source || "").toLowerCase();
      const isAudience =
        r.type === "audience" || src.includes("audience");
      if (src === "tomatoes" || src === "rottentomatoes" || src === "rt") {
        src = isAudience ? "rtaudience" : "rt";
      } else if (isAudience && (src === "" || src === "tomatoesaudience")) {
        src = "rtaudience";
      } else if (src === "themoviedb") {
        src = "tmdb";
      } else if (src === "myanimelist") {
        src = "mal";
      }
      out.sources[src] = { value: r.value, votes: r.votes || 0 };
    }
    if (data.score != null) out.sources.mdblist = { value: data.score };
    return out;
  }

  async function fetchRatings(source, id, type) {
    const apiKey = getApiKey();
    if (!apiKey || isRateLimited()) return null;

    let provider;
    if (source === "imdb") provider = "imdb";
    else if (source === "tmdb") provider = "tmdb";
    else return null; // kitsu / mal / anilist not supported by this endpoint

    const mediaType = type === "series" ? "show" : "movie";
    const cacheKey = `${provider}:${mediaType}:${id}`;

    if (memCache.has(cacheKey)) return memCache.get(cacheKey);
    const cached = sessionGet(cacheKey);
    if (cached !== undefined) {
      memCache.set(cacheKey, cached);
      return cached;
    }

    const url = `https://api.mdblist.com/${provider}/${mediaType}/${encodeURIComponent(
      id,
    )}?apikey=${encodeURIComponent(apiKey)}`;

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);

      if (res.status === 429) {
        markRateLimited();
        console.warn("[Detail Ratings] MDBList rate limited (429).");
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        console.warn("[Detail Ratings] MDBList rejected the API key.");
        window.dispatchEvent(new CustomEvent("kai-mdblist-key-invalid"));
        return null;
      }
      if (!res.ok) {
        console.warn(`[Detail Ratings] MDBList HTTP ${res.status}`);
        return null;
      }

      const data = await res.json();
      const normalized =
        data && data.title ? normalizeRatings(data) : null;
      memCache.set(cacheKey, normalized);
      sessionSet(cacheKey, normalized);
      return normalized;
    } catch (err) {
      console.warn("[Detail Ratings] MDBList request failed:", err.message);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROW BUILDER
  // ───────────────────────────────────────────────────────────────────────────
  function badge(opts) {
    const el = document.createElement(opts.href ? "a" : "div");
    el.className = "kai-detail-rating" + (opts.className ? " " + opts.className : "");
    if (opts.href) {
      el.href = opts.href;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.tabIndex = -1;
      el.addEventListener("click", (e) => e.stopPropagation());
    }
    if (opts.title) el.title = opts.title;

    if (opts.logo) {
      const img = document.createElement("img");
      img.className = "kai-detail-rating-logo";
      img.src = opts.logo;
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      el.appendChild(img);
    } else if (opts.svg) {
      const span = document.createElement("span");
      span.className = "kai-detail-rating-logo kai-detail-rating-svg";
      span.innerHTML = opts.svg;
      el.appendChild(span);
    }

    const text = document.createElement("span");
    text.className = "kai-detail-rating-text";
    text.textContent = opts.text;
    if (opts.color) text.style.color = opts.color;
    el.appendChild(text);
    return el;
  }

  function buildRow(ratings, imdbId) {
    const row = document.createElement("div");
    row.className = "kai-detail-ratings";
    const s = ratings.sources;
    let count = 0;

    const num = (v) => Number(v);

    if (s.imdb != null) {
      const v = num(s.imdb.value);
      row.appendChild(
        badge({
          logo: LOGOS.imdb,
          text: `★ ${v.toFixed(1)}`,
          color: getImdbColor(v),
          title: "IMDb",
          href: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
        }),
      );
      count++;
    }

    if (s.rt != null) {
      const v = Math.round(num(s.rt.value));
      const fresh = v >= 60;
      row.appendChild(
        badge({
          logo: fresh ? LOGOS.rtFresh : LOGOS.rtRotten,
          text: `${v}%`,
          className: fresh ? "kai-rt-fresh" : "kai-rt-rotten",
          title: "Rotten Tomatoes — Critics",
          href: "https://www.rottentomatoes.com/",
        }),
      );
      count++;
    }

    if (s.rtaudience != null) {
      const v = Math.round(num(s.rtaudience.value));
      const liked = v >= 60;
      row.appendChild(
        badge({
          logo: liked ? LOGOS.rtAudienceFresh : LOGOS.rtAudienceRotten,
          text: `${v}%`,
          className: liked ? "kai-rt-fresh" : "kai-rt-rotten",
          title: "Rotten Tomatoes — Audience",
          href: "https://www.rottentomatoes.com/",
        }),
      );
      count++;
    }

    if (s.metacritic != null) {
      const v = Math.round(num(s.metacritic.value));
      row.appendChild(
        badge({
          logo: LOGOS.metacritic,
          text: `${v}`,
          className: metacriticClass(v),
          title: "Metacritic",
          href: "https://www.metacritic.com/",
        }),
      );
      count++;
    }

    if (s.tmdb != null) {
      let v = num(s.tmdb.value);
      if (v <= 10) v *= 10;
      const tmdbId = ratings.ids.tmdb || ratings.ids.themoviedb;
      const tmdbType = ratings.type === "series" ? "tv" : "movie";
      row.appendChild(
        badge({
          logo: LOGOS.tmdb,
          className: "kai-tmdb",
          text: `${Math.round(v)}%`,
          title: "TMDB",
          href: tmdbId
            ? `https://www.themoviedb.org/${tmdbType}/${tmdbId}`
            : "https://www.themoviedb.org/",
        }),
      );
      count++;
    }

    if (s.letterboxd != null) {
      row.appendChild(
        badge({
          logo: LOGOS.letterboxd,
          className: "kai-letterboxd",
          text: num(s.letterboxd.value).toFixed(1),
          title: "Letterboxd (out of 5)",
          href: "https://letterboxd.com/",
        }),
      );
      count++;
    }

    if (s.trakt != null) {
      row.appendChild(
        badge({
          svg: TRAKT_SVG,
          text: `${Math.round(num(s.trakt.value))}%`,
          title: "Trakt",
          href: "https://trakt.tv/",
        }),
      );
      count++;
    }

    if (s.mal != null) {
      row.appendChild(
        badge({
          logo: LOGOS.mal,
          text: num(s.mal.value).toFixed(2),
          title: "MyAnimeList",
          href: "https://myanimelist.net/",
        }),
      );
      count++;
    }

    if (s.mdblist != null) {
      const v = Math.round(num(s.mdblist.value));
      row.appendChild(
        badge({
          logo: LOGOS.mdblist,
          className: "kai-mdblist " + mdblistClass(v),
          text: `${v}`,
          title: "MDBList score",
          href: "https://mdblist.com/",
        }),
      );
      count++;
    }

    return count > 0 ? row : null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROUTE + INJECTION
  // ───────────────────────────────────────────────────────────────────────────
  const DETAIL_RE = /^#\/detail\/(movie|series)\/([^/?]+)/;

  function currentDetail() {
    const m = window.location.hash.match(DETAIL_RE);
    if (!m) return null;
    const type = m[1];
    let raw = decodeURIComponent(m[2]).split("/")[0].split("?")[0];
    let source = "imdb";
    let id = raw;
    const prefix = raw.match(/^([a-z]+):(.+)$/i);
    if (prefix) {
      source = prefix[1].toLowerCase();
      id = prefix[2];
    }
    return { type, source, id, imdbId: source === "imdb" ? id : null };
  }

  function findMetaContainer() {
    return (
      document.querySelector(".meta-info-container-ub8AH") ||
      document.querySelector('[class*="meta-info-container"]')
    );
  }

  function removeRow() {
    document.querySelectorAll(".kai-detail-ratings").forEach((el) => el.remove());
  }

  let processing = false;

  async function process() {
    if (processing) return;

    const detail = currentDetail();
    if (!detail || !isEnabled() || !getApiKey()) {
      removeRow();
      return;
    }

    const container = findMetaContainer();
    if (!container) return; // observer will retry

    const existing = container.querySelector(".kai-detail-ratings");
    if (existing && existing.dataset.kaiId === detail.id) return; // already done

    processing = true;
    try {
      const ratings = await fetchRatings(detail.source, detail.id, detail.type);

      // Route may have changed while we awaited the network.
      const now = currentDetail();
      if (!now || now.id !== detail.id) return;
      if (!ratings) {
        removeRow();
        return;
      }

      const liveContainer = findMetaContainer();
      if (!liveContainer) return;
      removeRow();

      const row = buildRow(
        Object.assign({ type: detail.type }, ratings),
        detail.imdbId || ratings.ids.imdb,
      );
      if (!row) return;
      row.dataset.kaiId = detail.id;

      const anchor =
        liveContainer.querySelector(".action-buttons-container-XbKVa") ||
        liveContainer.querySelector('[class*="action-buttons-container"]');
      if (anchor && anchor.parentNode === liveContainer) {
        anchor.insertAdjacentElement("afterend", row);
      } else {
        liveContainer.appendChild(row);
      }
      console.log("[Detail Ratings] Injected ratings for", detail.id);
    } finally {
      processing = false;
    }
  }

  const debounced = (() => {
    let t = null;
    return () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        process().catch((e) => console.warn("[Detail Ratings]", e));
      }, 200);
    };
  })();

  window.addEventListener("hashchange", () => {
    if (!currentDetail()) removeRow();
    debounced();
  });
  window.addEventListener("kai-settings-changed", debounced);
  window.addEventListener("kai-mdblist-key-invalid", removeRow);

  const observer = new MutationObserver(debounced);
  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    debounced();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  console.log("[Detail Ratings] Loaded v1.0.0");
})();
