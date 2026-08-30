/**
 * @name YouTube Clean
 * @description Hides the embedded YouTube player chrome for YouTube sources so only the video shows, and keeps click-to-pause working through Stremio.
 * @version 1.0.0
 * @author Antigravity
 *
 * For reference: YouTube sources come from the "youtubio" addon
 * (youtubio.elfhosted.com), which resolves them to Stremio's built-in YouTube
 * player — a cross-origin youtube.com/embed <iframe> (#widget2 in .video-tkpQm).
 *
 * The heavy lifting is CSS (youtube-clean.css) — `pointer-events: none` on the
 * cross-origin YouTube <iframe> means it never sees the mouse input that would
 * summon its title bar, play button, end cards or context menu. This script
 * only restores the two things that go with it:
 *   - a transparent catcher over the iframe so a click in the video area still
 *     toggles play/pause (dispatched as Space, which Stremio's player listens
 *     for on window — see the input contract), not routed through YouTube;
 *   - swallowing the context menu in that region.
 */

(function () {
  "use strict";

  const CONFIG = {
    PLAYER_ROUTE: "#/player",
    HASHCHANGE_DELAY_MS: 1000,
    OBSERVER_DEBOUNCE_MS: 50,
    OBSERVER_TIMEOUT_MS: 15000,
  };

  const state = {
    isInitialized: false,
    catcher: null,
    observer: null,
    observerTimeoutId: null,
    hashTimeoutId: null,
  };

  const DOMManager = {
    findYouTubeIframe() {
      return (
        document.querySelector(".video-tkpQm iframe") ||
        document.querySelector("#widget2") ||
        document.querySelector('iframe[src*="youtube"]')
      );
    },

    findVideoHost() {
      const iframe = this.findYouTubeIframe();
      if (iframe && iframe.parentElement) return iframe.parentElement;
      return (
        document.querySelector(".video-tkpQm") ||
        document.querySelector("[class*='video-']")
      );
    },
  };

  const Playback = {
    togglePlayPause() {
      // Stremio's player keydown handler (on window) maps Space -> play/pause.
      // keyCode is set too so the bundled spatial-nav polyfill stays happy.
      ["keydown", "keyup"].forEach((type) => {
        window.dispatchEvent(
          new KeyboardEvent(type, {
            key: " ",
            code: "Space",
            keyCode: 32,
            which: 32,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
  };

  const Catcher = {
    onClick(event) {
      // Don't let the click also reach any Stremio video-area handler — we
      // want exactly one toggle per click.
      event.preventDefault();
      event.stopPropagation();
      Playback.togglePlayPause();
    },

    onContextMenu(event) {
      event.preventDefault();
    },

    attach(host) {
      if (!host) return;
      if (state.catcher && host.contains(state.catcher)) return;

      const catcher = document.createElement("div");
      catcher.className = "kai-yt-click-catcher";
      catcher.addEventListener("click", this.onClick);
      catcher.addEventListener("contextmenu", this.onContextMenu);

      // Host must be a positioned box for `inset: 0` to line up with the iframe.
      const position = getComputedStyle(host).position;
      if (position === "static") host.style.position = "relative";

      host.appendChild(catcher);
      state.catcher = catcher;
    },

    detach() {
      if (state.catcher) {
        state.catcher.removeEventListener("click", this.onClick);
        state.catcher.removeEventListener("contextmenu", this.onContextMenu);
        state.catcher.remove();
        state.catcher = null;
      }
    },
  };

  const InitializationManager = {
    init() {
      if (state.isInitialized) return;
      if (!window.location.hash.startsWith(CONFIG.PLAYER_ROUTE)) return;

      state.isInitialized = true;
      this.trySetup();
      this.startObserver();
    },

    trySetup() {
      const iframe = DOMManager.findYouTubeIframe();
      if (!iframe) return false;
      Catcher.attach(DOMManager.findVideoHost());
      return true;
    },

    startObserver() {
      if (state.observer) return;

      let debounceTimer = null;
      state.observer = new MutationObserver(() => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const iframe = DOMManager.findYouTubeIframe();
          if (!iframe) {
            // Non-YouTube source (mpv/native <video>) — nothing to do.
            Catcher.detach();
            return;
          }
          if (!state.catcher || !state.catcher.isConnected) {
            Catcher.attach(DOMManager.findVideoHost());
          }
        }, CONFIG.OBSERVER_DEBOUNCE_MS);
      });

      state.observer.observe(document.body, { childList: true, subtree: true });

      state.observerTimeoutId = setTimeout(
        () => this.stopObserver(),
        CONFIG.OBSERVER_TIMEOUT_MS,
      );
    },

    stopObserver() {
      if (state.observer) {
        state.observer.disconnect();
        state.observer = null;
      }
      if (state.observerTimeoutId) {
        clearTimeout(state.observerTimeoutId);
        state.observerTimeoutId = null;
      }
    },

    cleanup() {
      this.stopObserver();
      Catcher.detach();
      state.isInitialized = false;
    },
  };

  const GlobalLifecycle = {
    start() {
      this.checkRoute();
      window.addEventListener("hashchange", () => {
        if (state.hashTimeoutId) clearTimeout(state.hashTimeoutId);
        state.hashTimeoutId = setTimeout(() => {
          state.hashTimeoutId = null;
          this.checkRoute();
        }, CONFIG.HASHCHANGE_DELAY_MS);
      });
    },

    checkRoute() {
      if (window.location.hash.startsWith(CONFIG.PLAYER_ROUTE)) {
        InitializationManager.init();
      } else if (state.isInitialized) {
        InitializationManager.cleanup();
      }
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => GlobalLifecycle.start());
  } else {
    GlobalLifecycle.start();
  }
})();
