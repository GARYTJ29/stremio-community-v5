/**
 * @name SVP Live Toggle
 * @description Adds an SVP button to the player control bar (and a Ctrl+S shortcut)
 *              that turns frame interpolation on and off during playback
 * @version 1.0.0
 * @author stremio-community-v5
 *
 * Without this, SVP is a load-time decision: mpv-bridge.js reads the Settings
 * toggles and profile-manager.lua appends the @SVP filter once, when the file
 * loads. This drives profile-manager's "toggle-svp" script-message instead, so
 * the filter can be added and removed mid-file.
 *
 * The button never guesses its own state. profile-manager publishes the truth to
 * the "user-data/kai/svp" property; the shell forwards property changes to the
 * WebView, and this reads them back. So the button also stays right when SVP is
 * flipped from a key binding, or when a .vpy fails to load and SVP silently
 * drops out of the chain.
 *
 * Scope: per playback. Toggling here deliberately does not rewrite the
 * kai-svp-enabled setting, so the next file starts from Settings again.
 */

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.KaiSvpToggle && window.KaiSvpToggle.initialized) return;
  window.KaiSvpToggle = { initialized: true };

  const PLAYER_ROUTE = "#/player";
  const SVP_PROP = "user-data/kai/svp";
  const VF_PROP = "vf";
  const BUTTON_ID = "kai-svp-toggle";
  const OBSERVE_DEBOUNCE_MS = 250;
  const FALLBACK_MS = 6000;

  const CONTROL_BAR = '[class*="control-bar-container"]';
  const CONTROL_BUTTONS = '[class*="control-bar-buttons-container"]';
  const MENU_LAYER = '[class*="menu-layer"],[class*="side-drawer-layer"]';
  const PLAYER_CONTAINER = '[class*="player-container"]';

  // "on" | "off" | "unavailable" - unavailable covers both "no VapourSynth" and
  // "no profile applied yet", and hides the button either way.
  let svpState = "unavailable";
  let button = null;
  let observer = null;
  let observerTimer = null;
  let propObserved = false;
  let sawSvpProp = false;
  let vfObserved = false;
  let fallbackTimer = null;

  // ── shell transport ──────────────────────────────────────────────────────

  function shell(event, args) {
    try {
      if (!window.chrome || !window.chrome.webview) return;
      window.chrome.webview.postMessage(
        JSON.stringify({
          type: 6,
          object: "transport",
          method: "handleInboundJSON",
          args: [event, args || []],
        }),
      );
    } catch (e) {
      /* shell not attached */
    }
  }

  function toggleSvp() {
    shell("mpv-command", [
      "script-message-to",
      "profile_manager",
      "toggle-svp",
    ]);
  }

  // Asked for once per page load: the shell re-registers the observer with mpv on
  // every call, so repeating it would duplicate every property change.
  function observeSvpProp() {
    if (propObserved) return;
    propObserved = true;
    shell("mpv-observe-prop", [SVP_PROP]);
  }

  // profile-manager publishing to user-data is the path that knows whether
  // VapourSynth is even installed. If nothing arrives - an older extras build, or
  // an mpv that does not notify on user-data sub-paths - fall back to reading the
  // filter chain, which at least gets on/off right.
  function armFallback() {
    if (fallbackTimer || sawSvpProp || vfObserved) return;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      if (sawSvpProp || vfObserved) return;
      vfObserved = true;
      shell("mpv-observe-prop", [VF_PROP]);
    }, FALLBACK_MS);
  }

  function disarmFallback() {
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  function onShellMessage(event) {
    let msg = event && event.data;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch (e) {
        return;
      }
    }
    if (!msg || !Array.isArray(msg.args)) return;
    if (msg.args[0] !== "mpv-prop-change") return;

    const change = msg.args[1];
    if (!change) return;

    if (change.name === SVP_PROP) {
      sawSvpProp = true;
      disarmFallback();
      setState(typeof change.data === "string" ? change.data : "unavailable");
      return;
    }

    // Fallback only, and only until the real state shows up. Presence in the
    // chain is the test, not the enabled flag: reactive_vf_bypass disables the
    // filter around every seek without removing it.
    if (change.name === VF_PROP && vfObserved && !sawSvpProp) {
      const chain = Array.isArray(change.data) ? change.data : [];
      const present = chain.some(
        (f) => f && (f.name === "vapoursynth" || f.label === "SVP"),
      );
      setState(present ? "on" : "off");
    }
  }

  // ── button ───────────────────────────────────────────────────────────────

  function setState(next) {
    if (next !== "on" && next !== "off") next = "unavailable";
    svpState = next;
    applyState();
  }

  function applyState() {
    if (!button) return;
    button.dataset.svp = svpState;
    button.setAttribute("aria-pressed", svpState === "on" ? "true" : "false");
    button.title =
      svpState === "on"
        ? "SVP frame interpolation: on (Ctrl+S)"
        : "SVP frame interpolation: off (Ctrl+S)";
  }

  function createButton() {
    const el = document.createElement("div");
    el.id = BUTTON_ID;
    // "button-container" in the class name is deliberate: gamepad.cpp walks the
    // control bar with [class*="button-container"], so naming it this way is what
    // puts the toggle in reach of the d-pad alongside the real controls.
    el.className = "kai-svp-toggle button-container-kai-svp";
    el.tabIndex = -1;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Toggle SVP frame interpolation");
    el.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M13.2 2 4 13.4h5.9L8.8 22 18 10.6h-5.9z"/></svg>' +
      '<span class="kai-svp-label">SVP</span>';

    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSvp();
    });
    // The web UI's own Buttons blur on mousedown and the player container turns a
    // mousedown into "close every menu"; neither should happen from this one.
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " " && e.code !== "Space") return;
      e.preventDefault();
      e.stopPropagation();
      toggleSvp();
    });

    return el;
  }

  function mount() {
    const bar = document.querySelector(CONTROL_BAR);
    if (!bar) return false;
    const row = bar.querySelector(CONTROL_BUTTONS) || bar;

    if (!button) button = createButton();
    if (button.parentNode !== row) row.appendChild(button);
    applyState();
    return true;
  }

  function unmount() {
    if (button && button.parentNode) button.parentNode.removeChild(button);
  }

  // ── keyboard shortcut ────────────────────────────────────────────────────

  // The web UI maps a bare "S" to the subtitles menu. Its handler sits on window
  // too and does not check for modifiers, so this runs in the capture phase and
  // stops the event outright rather than letting Ctrl+S reach it.
  function onKeyDown(e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code !== "KeyS" && String(e.key).toLowerCase() !== "s") return;
    if (!isPlayerRoute()) return;

    const target = e.target;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    // If the UI got the keypress first anyway, its subtitles menu is now open
    // over the video. Close it the way the UI does - Escape would also navigate
    // back a page.
    const menuWasOpen = !!document.querySelector(MENU_LAYER);
    toggleSvp();
    if (!menuWasOpen) setTimeout(closeStrayMenu, 0);
  }

  function closeStrayMenu() {
    if (!document.querySelector(MENU_LAYER)) return;
    const container = document.querySelector(PLAYER_CONTAINER);
    if (!container) return;
    container.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function isPlayerRoute() {
    return window.location.hash.startsWith(PLAYER_ROUTE);
  }

  // React rebuilds the control bar as the overlay comes and goes, which drops the
  // button out of the DOM; re-mounting on mutation is what keeps it there.
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        const el = document.getElementById(BUTTON_ID);
        if (!el || !el.isConnected) mount();
      }, OBSERVE_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observerTimer) {
      clearTimeout(observerTimer);
      observerTimer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function checkRoute() {
    if (isPlayerRoute()) {
      observeSvpProp();
      armFallback();
      mount();
      startObserver();
    } else {
      disarmFallback();
      stopObserver();
      unmount();
    }
  }

  function start() {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("hashchange", () => setTimeout(checkRoute, 250));
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener("message", onShellMessage);
    }
    checkRoute();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
