/**
 * @name Online Ratings Settings
 * @description Adds an "Online Ratings" section to Stremio settings for entering a
 *              free MDBList API key. The key powers the extra rating badges shown
 *              on detail pages by UI/detail-ratings.js.
 * @version 1.0.0
 *
 * Storage keys match Stremio-Kai so a future full-metadata port can share them:
 *   kai-api-key-mdblist         -> obfuscated API key
 *   kai-detail-ratings-enabled  -> "true" | "false"
 */

(function () {
  "use strict";

  if (window.KaiRatingsSettings?.initialized) return;
  window.KaiRatingsSettings = { initialized: true };

  const KEY_STORAGE = "kai-api-key-mdblist";
  const ENABLED_STORAGE = "kai-detail-ratings-enabled";
  const TARGET_ROUTE = "#/settings";
  const SECTION_MARKER = "kai-ratings-section";
  const NAV_MARKER = "kai-ratings-nav-button";
  const SIDE_MENU_SELECTOR = ".side-menu-container-NG17D";
  const NAV_BUTTON_CLASS = "side-menu-button-vbkJ1";
  const NAV_SELECTED_CLASS = "selected-yhdng";
  const NAV_SPACER_SELECTOR = ".spacing-fpLUM";
  const VALIDATE_URL = "https://api.mdblist.com/lists/user/?apikey=";

  // ───────────────────────────────────────────────────────────────────────────
  // STORAGE
  // ───────────────────────────────────────────────────────────────────────────
  function getKey() {
    try {
      const raw = localStorage.getItem(KEY_STORAGE);
      if (!raw) return "";
      try {
        return decodeURIComponent(atob(raw));
      } catch (_) {
        return raw;
      }
    } catch (_) {
      return "";
    }
  }

  function setKey(value) {
    try {
      const v = (value || "").trim();
      if (!v) {
        localStorage.removeItem(KEY_STORAGE);
      } else {
        localStorage.setItem(KEY_STORAGE, btoa(encodeURIComponent(v)));
      }
      notifyChange();
    } catch (e) {
      console.error("[Online Ratings] Failed to store key", e);
    }
  }

  function isEnabled() {
    try {
      return localStorage.getItem(ENABLED_STORAGE) !== "false";
    } catch (_) {
      return true;
    }
  }

  function setEnabled(value) {
    try {
      localStorage.setItem(ENABLED_STORAGE, value ? "true" : "false");
      notifyChange();
    } catch (_) {}
  }

  function notifyChange() {
    window.dispatchEvent(new Event("kai-settings-changed"));
  }

  async function validateKey(key) {
    if (!key || !key.trim()) return { valid: false, error: "Empty key" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(VALIDATE_URL + encodeURIComponent(key.trim()), {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(t);
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403)
        return { valid: false, error: "Invalid API key" };
      return { valid: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return {
        valid: false,
        error: e.name === "AbortError" ? "Timed out" : "Network error",
      };
    }
  }

  window.KaiRatingsSettings.getKey = getKey;
  window.KaiRatingsSettings.isEnabled = isEnabled;

  // ───────────────────────────────────────────────────────────────────────────
  // UI BUILDERS (Stremio-native classes, styled by Theme/Settings.css)
  // ───────────────────────────────────────────────────────────────────────────
  function categoryHeader(label) {
    const el = document.createElement("div");
    el.className = "section-category-container-EOuS0";
    el.innerHTML = `<div style="display:flex;align-items:center;">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="margin-right:8px;">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"
              fill="#e6c200"/></svg>
      <span class="label-FFamJ">${label}</span></div>`;
    return el;
  }

  function updateBadge(badge, status, msg) {
    badge.dataset.status = status;
    if (status === "valid")
      badge.innerHTML = '<span class="kai-status-icon status-valid">✓</span>';
    else if (status === "invalid")
      badge.innerHTML = '<span class="kai-status-icon status-invalid">✗</span>';
    else if (status === "validating")
      badge.innerHTML = '<span class="kai-status-icon status-loading">⏳</span>';
    else badge.innerHTML = "";
    badge.title = msg || "";
  }

  function apiKeyRow() {
    const row = document.createElement("div");
    row.className = "option-container-EGlcv kai-api-key-row";

    const labelContainer = document.createElement("div");
    labelContainer.className = "option-name-container-exGMI";
    labelContainer.innerHTML = `
      <div class="label-FFamJ">MDBList API Key</div>
      <div class="kai-api-key-hint">Free key at
        <a href="https://mdblist.com/preferences/#api" target="_blank" rel="noopener noreferrer">mdblist.com/preferences/#api</a>
        &nbsp;&bull;&nbsp; free tier allows ~1000 requests/day</div>`;
    row.appendChild(labelContainer);

    const wrapper = document.createElement("div");
    wrapper.className = "kai-settings-input-wrapper";

    const input = document.createElement("input");
    input.className = "kai-settings-input";
    input.type = "password";
    input.placeholder = "Enter API key…";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = getKey();

    const badge = document.createElement("div");
    badge.className = "kai-settings-status";
    updateBadge(badge, input.value ? "valid" : "empty");

    let timer = null;
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      const val = input.value.trim();
      if (!val) {
        setKey("");
        updateBadge(badge, "empty");
        return;
      }
      updateBadge(badge, "validating");
      timer = setTimeout(async () => {
        const res = await validateKey(val);
        if (res.valid) {
          setKey(val);
          updateBadge(badge, "valid");
        } else {
          updateBadge(badge, "invalid", res.error);
        }
      }, 800);
    });

    wrapper.appendChild(input);
    wrapper.appendChild(badge);
    row.appendChild(wrapper);
    return row;
  }

  function toggleRow() {
    const row = document.createElement("div");
    row.className = "option-container-EGlcv kai-api-key-row";

    const labelContainer = document.createElement("div");
    labelContainer.className = "option-name-container-exGMI";
    labelContainer.innerHTML = `
      <div class="label-FFamJ">Show ratings on detail pages</div>
      <div class="kai-api-key-hint">Adds Rotten Tomatoes, Metacritic, TMDB, Letterboxd and Trakt
        next to the built-in IMDb rating</div>`;
    row.appendChild(labelContainer);

    const toggle = document.createElement("div");
    toggle.tabIndex = 0;
    toggle.className =
      "option-input-container-NPgpT toggle-container-lZfHP button-container-zVLH6";
    if (isEnabled()) toggle.classList.add("checked");
    toggle.innerHTML = '<div class="toggle-toOWM"></div>';
    toggle.addEventListener("click", () => {
      const next = !toggle.classList.contains("checked");
      toggle.classList.toggle("checked", next);
      setEnabled(next);
    });

    row.appendChild(toggle);
    return row;
  }

  function footerNote() {
    const footer = document.createElement("div");
    footer.className = "wrapper-FMNA6";
    footer.innerHTML = `<div class="footer-jhua_ kai-api-keys-footer">
      <div class="description-label-h5DXc kai-info-note">
        <svg class="kai-note-icon" viewBox="0 0 24 24" fill="none"><path d="M12 16V12M12 8H12.01M7.8 21H16.2C17.8802 21 18.7202 21 19.362 20.673C19.9265 20.3854 20.3854 19.9265 20.673 19.362C21 18.7202 21 17.8802 21 16.2V7.8C21 6.11984 21 5.27976 20.673 4.63803C20.3854 4.07354 19.9265 3.6146 19.362 3.32698C18.7202 3 17.8802 3 16.2 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V16.2C3 17.8802 3 18.7202 3.32698 19.362C3.6146 19.9265 4.07354 20.3854 4.63803 20.673C5.27976 21 6.11984 21 7.8 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span><strong>Note:</strong> Ratings are fetched from MDBList and cached per session.
        Anime titles (kitsu / mal / anilist IDs) are not covered by this endpoint.</span>
      </div></div>`;
    return footer;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INJECTION
  // ───────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // SIDE MENU
  // ───────────────────────────────────────────────────────────────────────────
  // Stremio's own nav buttons are React-rendered and its scroll-spy only knows
  // about its own sections, so ours needs both the button and the highlighting.
  function injectNavButton() {
    const sideMenu = document.querySelector(SIDE_MENU_SELECTOR);
    if (!sideMenu || sideMenu.querySelector("." + NAV_MARKER)) return;

    const button = document.createElement("div");
    button.className = NAV_BUTTON_CLASS + " " + NAV_MARKER;
    button.tabIndex = 0;
    button.title = "Online Ratings";
    button.textContent = "Online Ratings";
    button.addEventListener("click", () => {
      document
        .querySelector("." + SECTION_MARKER)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Before the spacer that pushes the version labels to the bottom.
    const spacer = sideMenu.querySelector(NAV_SPACER_SELECTOR);
    if (spacer) sideMenu.insertBefore(button, spacer);
    else sideMenu.appendChild(button);

    watchScrollSpy();
  }

  let spyBound = false;
  function watchScrollSpy() {
    if (spyBound) return;
    spyBound = true;
    // Scroll events do not bubble, but a capturing listener on the document
    // still sees them -- which saves guessing which element actually scrolls.
    document.addEventListener("scroll", syncSpy, { capture: true, passive: true });
    syncSpy();
  }

  function syncSpy() {
    const section = document.querySelector("." + SECTION_MARKER);
    const button = document.querySelector("." + NAV_MARKER);
    const scroller = document.querySelector(".sections-container-EUKAe");
    if (!section || !button || !scroller) return;

    // Ours is the last section, so it is current once its title has reached the
    // top of the scroll viewport.
    const active =
      section.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= 8;

    button.classList.toggle(NAV_SELECTED_CLASS, active);
    if (!active) return;
    // Stremio's spy is stuck on its own last section while we are here; clearing
    // it avoids two highlighted entries. It re-renders (and takes over again)
    // as soon as its own scroll state changes.
    document
      .querySelectorAll("." + NAV_BUTTON_CLASS + "." + NAV_SELECTED_CLASS)
      .forEach((el) => {
        if (el !== button) el.classList.remove(NAV_SELECTED_CLASS);
      });
  }

  function injectSection() {
    if (document.querySelector("." + SECTION_MARKER)) return;

    const sectionsContainer = document.querySelector(".sections-container-EUKAe");
    if (!sectionsContainer) return;

    const section = document.createElement("div");
    section.className =
      "section-container-twzKQ kai-api-keys-section " + SECTION_MARKER;

    const title = document.createElement("div");
    title.className = "section-title-Nt71Z";
    title.textContent = "Online Ratings";
    section.appendChild(title);

    section.appendChild(categoryHeader("MDBList"));
    section.appendChild(apiKeyRow());
    section.appendChild(toggleRow());
    section.appendChild(footerNote());

    sectionsContainer.appendChild(section);
    injectNavButton();
    console.log("[Online Ratings] Settings section injected");
  }

  function init() {
    let debounce = null;
    const observer = new MutationObserver(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!window.location.hash.startsWith(TARGET_ROUTE)) return;
        injectSection();
        injectNavButton();
      }, 60);
    });

    const armObserver = () => {
      if (window.location.hash.startsWith(TARGET_ROUTE)) {
        injectSection();
        injectNavButton();
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        observer.disconnect();
      }
    };

    window.addEventListener("hashchange", armObserver);
    armObserver();
    console.log("[Online Ratings] Loaded v1.0.0");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
