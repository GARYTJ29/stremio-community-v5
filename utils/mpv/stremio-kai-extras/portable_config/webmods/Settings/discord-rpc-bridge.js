/**
 * @name Discord RPC Bridge
 * @description Makes Stremio's own "Show Discord Rich Presence" toggle drive the shell
 * @version 1.1.0
 *
 * The shell keeps its own cached DiscordRPC flag and gates every presence
 * update on it (SetDiscordPresenceFromArgs). Without this bridge the two
 * disagree: the page hides its activity events while the shell separately
 * refuses to publish them, and the shell's copy has no UI at all.
 *
 * Ownership:
 *   - A profile that has never stored `isDiscordRpcOn` is seeded from the
 *     shell's [General] DiscordRPC, handed over as `window.__shellSettings`.
 *   - After that the settings toggle is the setting; every change is pushed to
 *     the shell, which writes it back to the .ini.
 *
 * Timing matters: Stremio's StorageProvider reads `localProfile` once, in a
 * useState initializer. Seeding has to happen synchronously here, at
 * document-created, or React's copy wins and overwrites it.
 *
 * The reverse direction (shell -> page) covers the tray's "Show Status on
 * Discord" item: the shell pushes the new value in a `shell-settings` message
 * and this bridge relays it into the page. When the settings screen is open we
 * click Stremio's own toggle so React keeps ownership; otherwise we write
 * `localProfile` directly, the same partial-merge write used for seeding.
 */

(function () {
  "use strict";

  if (window.ShellRpcBridge?.initialized) return;
  window.ShellRpcBridge = { initialized: true };

  const PROFILE_KEY = "localProfile";
  const RPC_KEY = "isDiscordRpcOn";

  function readProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function sendToShell(event, args) {
    window.chrome?.webview?.postMessage(
      JSON.stringify({
        type: 6,
        object: "transport",
        method: "handleInboundJSON",
        args: [event, args],
      }),
    );
  }

  let lastPushed = null;
  function pushToShell(on) {
    const value = on ? "1" : "0";
    if (value === lastPushed) return;
    lastPushed = value;
    sendToShell("set-discord-rpc", [value]);
  }

  // ── Seed or adopt, before the page reads storage ───────────────────────────
  const profile = readProfile();
  const shellDefault = window.__shellSettings?.discordRpc;

  if (profile && typeof profile[RPC_KEY] === "boolean") {
    pushToShell(profile[RPC_KEY]);
  } else if (typeof shellDefault === "boolean") {
    // Partial writes are safe: StorageProvider merges over its own defaults.
    try {
      localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify({ ...(profile || {}), [RPC_KEY]: shellDefault }),
      );
    } catch (e) {
      console.error("[RPC Bridge] Failed to seed localProfile", e);
    }
    pushToShell(shellDefault);
  }

  // ── Follow the shell (tray toggle) ────────────────────────────────────────
  const NATIVE_DISCORD_LABEL = "Show Discord Rich Presence";
  const OPTION_CLASS = "option-container-EGlcv";
  const LABEL_CLASS = "label-FFamJ";
  const TOGGLE_CONTAINER_CLASS = "toggle-container-lZfHP";
  const CHECKED_CLASS = "checked";

  function findNativeDiscordToggle() {
    for (const option of document.querySelectorAll("." + OPTION_CLASS)) {
      const label = option.querySelector("." + LABEL_CLASS);
      if (label?.textContent.trim() === NATIVE_DISCORD_LABEL) {
        return option.querySelector("." + TOGGLE_CONTAINER_CLASS);
      }
    }
    return null;
  }

  function applyFromShell(on) {
    const current = readProfile();
    if (current && current[RPC_KEY] === on) return;

    const toggle = findNativeDiscordToggle();
    if (toggle) {
      // React owns the state and the localStorage write; our setItem shadow
      // relays the resulting value back to the shell (deduped by lastPushed).
      if (toggle.classList.contains(CHECKED_CLASS) !== on) toggle.click();
      return;
    }

    // Settings screen isn't mounted — write the profile directly, as seeding
    // does. The shell already holds this value, so suppress the echo.
    lastPushed = on ? "1" : "0";
    try {
      localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify({ ...(current || {}), [RPC_KEY]: on }),
      );
    } catch (e) {
      console.error("[RPC Bridge] Failed to write localProfile", e);
    }
  }

  function onShellMessage(event) {
    let msg = event?.data;
    if (typeof msg === "string") {
      try {
        msg = JSON.parse(msg);
      } catch {
        return;
      }
    }
    if (!msg || !Array.isArray(msg.args) || msg.args[0] !== "shell-settings") return;
    const on = msg.args[1]?.discordRpc;
    if (typeof on === "boolean") applyFromShell(on);
  }

  window.chrome?.webview?.addEventListener("message", onShellMessage);

  // ── Follow the toggle ──────────────────────────────────────────────────────
  // A same-window write fires no storage event, and the toggle lives inside
  // Stremio's own React tree, so the localStorage write is the only hook.
  // Shadowing the instance method leaves sessionStorage alone.
  const nativeSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    nativeSetItem(key, value);
    if (key !== PROFILE_KEY) return;
    try {
      const next = JSON.parse(value);
      if (typeof next[RPC_KEY] === "boolean") pushToShell(next[RPC_KEY]);
    } catch {
      /* not our shape; nothing to relay */
    }
  };
})();
