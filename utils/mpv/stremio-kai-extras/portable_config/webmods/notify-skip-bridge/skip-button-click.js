/**
 * @name Skip Button Click Forwarder
 * @description The "Skip Intro/Outro" button is drawn by notify_skip.lua as an mpv ASS
 * overlay, not a real DOM element, so clicks on it land on whatever Stremio UI is
 * underneath (usually toggling play/pause) instead of reaching mpv. This listens for
 * clicks in the same screen region skip-toast.lua draws the button in (mirroring its
 * update_dimensions() math) and forwards them to mpv as the same "perform-skip"
 * script-message the Tab key already sends.
 *
 * Extracted from Stremio-Kai's webmods/Utilities/navigation.js (initSkipButtonClick),
 * which bundles a lot of unrelated navigation/gamepad logic this project doesn't use.
 */
(function () {
  "use strict";

  if (window.KaiSkipButtonClick?.initialized) return;
  window.KaiSkipButtonClick = { initialized: true };

  document.addEventListener(
    "click",
    (e) => {
      if (!window.location.hash.startsWith("#/player")) return;

      // Ignore clicks that are clearly targeting an active Stremio playback overlay.
      // The skip button is rendered by mpv as an ASS overlay beneath the web UI.
      if (
        e.target.closest(
          ".menu-layer-HZFG9, .dropdown-container-T9bZ2, .menu-container-B6cqK, .dialog-container-S5c_E, .modal-backdrop, .control-bar-container-xsWA7, .search-input-IQ0ZW, .search-bar-container-asfq1, .button-container-zVLH6, .language-option-O1Yr9, .variant-option-t7_LA, .option-COcvW, .option-GcPlB",
        )
      ) {
        return;
      }

      // Mirror skip-toast.lua update_dimensions() math (base height = 1080)
      const scale = window.innerHeight / 1080;
      const margin = 80 * scale;
      const btnWidth = 200 * scale;
      const btnHeight = 60 * scale;
      const extraOffset = 80 * scale; // space above control bar

      const ax = window.innerWidth - btnWidth - margin;
      const ay = window.innerHeight - btnHeight - margin - extraOffset;
      const bx = window.innerWidth - margin;
      const by = window.innerHeight - margin - extraOffset;

      if (
        e.clientX >= ax &&
        e.clientX <= bx &&
        e.clientY >= ay &&
        e.clientY <= by
      ) {
        e.stopPropagation();
        e.preventDefault();
        window.chrome?.webview?.postMessage(
          JSON.stringify({
            type: 6,
            object: "transport",
            method: "handleInboundJSON",
            args: [
              "mpv-command",
              ["script-message-to", "notify_skip", "perform-skip"],
            ],
          }),
        );
      }
    },
    { capture: true },
  );
})();
