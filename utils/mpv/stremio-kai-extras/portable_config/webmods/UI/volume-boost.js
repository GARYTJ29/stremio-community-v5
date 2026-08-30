/**
 * @name Volume Boost
 * @description Raises the player's volume ceiling to the shell's max and tints the boosted range
 * @version 2.0.0
 *
 * @changelog
 *   v2.0.0 - Tint moved onto the fill element's own background; no more overlay,
 *            geometry measurement, or per-slider observers
 *   v1.0.0 - Initial
 *
 * Stremio already supports a volume ceiling above 100 — its Max Volume setting
 * feeds `maxVolume` in `localProfile`, and the volume slider ranges 0..that.
 * The stock default is 130. This seeds it to the shell's ceiling ([MPV]
 * MaxVolume, which mpv also gets as `volume-max`) and sets the two stops
 * volume-boost.css needs to place the ramp.
 *
 * Both stops depend only on the ceiling, so they live on :root and are rewritten
 * only when it changes. The ramp is anchored to the bar rather than to the
 * current level, and Stremio's own mask on the fill reveals just the part that
 * has been reached — so there is nothing per-slider to track.
 *
 * Seeding runs synchronously at document-created: Stremio's StorageProvider
 * reads `localProfile` once in a useState initializer, so a later write would
 * just be overwritten by React's copy.
 */

(function () {
  "use strict";

  if (window.VolumeBoost?.initialized) return;
  window.VolumeBoost = { initialized: true };

  const PROFILE_KEY = "localProfile";
  const MAX_KEY = "maxVolume";
  // Stremio's own default. Anything else is a deliberate pick from the Max
  // Volume dropdown and is left alone.
  const STOCK_MAX = "130";
  const BOOST_FLOOR = 100;
  const FALLBACK_MAX = 130;

  function readProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ── Seed the ceiling before the page reads storage ─────────────────────────
  const shellMax = Number(window.__shellSettings?.maxVolume);
  const profile = readProfile();

  if (Number.isFinite(shellMax) && shellMax > BOOST_FLOOR) {
    const stored = profile?.[MAX_KEY];
    if (stored === undefined || stored === null || String(stored) === STOCK_MAX) {
      try {
        localStorage.setItem(
          PROFILE_KEY,
          JSON.stringify({ ...(profile || {}), [MAX_KEY]: String(shellMax) }),
        );
      } catch (e) {
        console.error("[Volume Boost] Failed to seed maxVolume", e);
      }
    }
  }

  // ── Place the ramp ─────────────────────────────────────────────────────────
  function applyStops() {
    const root = document.documentElement;
    if (!root) return;

    const raw = Number(readProfile()?.[MAX_KEY]);
    const max = Number.isFinite(raw) && raw > 0 ? raw : FALLBACK_MAX;

    // Where 100% sits on the bar, and the halfway point of the boost range above
    // it. At or below 100 both collapse to the far end, leaving the ramp fully
    // transparent.
    const start = max > BOOST_FLOOR ? (BOOST_FLOOR / max) * 100 : 100;
    const mid =
      max > BOOST_FLOOR
        ? ((BOOST_FLOOR + (max - BOOST_FLOOR) / 2) / max) * 100
        : 100;

    root.style.setProperty("--kai-volume-boost-start", start + "%");
    root.style.setProperty("--kai-volume-boost-mid", mid + "%");
  }

  // Changing Max Volume moves where the 100 mark falls on the bar. A same-window
  // write fires no storage event, and the dropdown lives inside Stremio's own
  // React tree, so the localStorage write is the only hook. Shadowing the
  // instance method leaves sessionStorage alone.
  const nativeSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    nativeSetItem(key, value);
    if (key === PROFILE_KEY) applyStops();
  };

  applyStops();
  // documentElement may not have existed yet at document-created time.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyStops);
  }
})();
