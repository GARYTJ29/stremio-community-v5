/**
 * @name General Shell Settings
 * @description Adds a "General" heading, Gamepad Support, and moves the Discord toggle there
 * @version 1.1.0
 *
 * Two rows land at the bottom of the General section, below "Blur Unwatched
 * Image":
 *
 *   Gamepad Support               — a shell setting (tray > Controller Support)
 *                                   with no presence in the settings UI at all.
 *   Show Stremio Status on        — Stremio's own "Show Discord Rich Presence",
 *   Discord                         which sits in the Player section under a
 *                                   name that reads like jargon.
 *
 * The Discord row is a proxy, not a copy: the real one is hidden and our click
 * is forwarded to it, so React keeps ownership of the state and of the
 * localStorage write. Reimplementing it would mean writing `localProfile`
 * behind React's back, and the next settings change would clobber it with
 * React's stale copy. discord-rpc-bridge.js then relays that write to the shell
 * as it would for any other change.
 */

(function () {
  "use strict";

  if (window.GeneralShellSettings?.initialized) return;
  window.GeneralShellSettings = { initialized: true };

  const TARGET_ROUTE = "#/settings";
  const GAMEPAD_MARKER = "kai-gamepad-row";
  const DISCORD_MARKER = "kai-discord-row";
  const GENERAL_MARKER = "kai-general-section";
  const GENERAL_TITLE_MARKER = "kai-general-title";
  const NATIVE_DISCORD_LABEL = "Show Discord Rich Presence";

  const SECTION_CLASS = "section-container-twzKQ";
  const SECTION_TITLE_CLASS = "section-title-Nt71Z";
  const OPTION_CLASS = "option-container-EGlcv";
  const NAME_CONTAINER_CLASS = "option-name-container-exGMI";
  const LABEL_CLASS = "label-FFamJ";
  const TOGGLE_CONTAINER_CLASS = "toggle-container-lZfHP";
  const INPUT_CONTAINER_CLASS = "option-input-container-NPgpT";
  const BUTTON_CONTAINER_CLASS = "button-container-zVLH6";
  const CHECKED_CLASS = "checked";

  // Seeded synchronously, then corrected by the shell's "shell-settings" push —
  // the injected global is registered once per session and goes stale after a
  // tray toggle.
  let gamepadEnabled = window.__shellSettings?.gamepadEnabled !== false;

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

  // ───────────────────────────────────────────────────────────────────────────
  // ROW BUILDER (Stremio-native classes, so it inherits the section's styling)
  // ───────────────────────────────────────────────────────────────────────────
  function buildRow(marker, label, checked, onToggle) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " " + marker;

    const nameContainer = document.createElement("div");
    nameContainer.className = NAME_CONTAINER_CLASS;
    const labelEl = document.createElement("div");
    labelEl.className = LABEL_CLASS;
    labelEl.textContent = label;
    nameContainer.appendChild(labelEl);
    row.appendChild(nameContainer);

    const toggle = document.createElement("div");
    toggle.tabIndex = 0;
    toggle.className = [
      INPUT_CONTAINER_CLASS,
      TOGGLE_CONTAINER_CLASS,
      BUTTON_CONTAINER_CLASS,
    ].join(" ");
    toggle.classList.toggle(CHECKED_CLASS, checked);
    toggle.innerHTML = '<div class="toggle-toOWM"></div>';

    const activate = () => onToggle(!toggle.classList.contains(CHECKED_CLASS));
    toggle.addEventListener("click", activate);
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    row.appendChild(toggle);
    return row;
  }

  function rowToggle(marker) {
    return document.querySelector("." + marker + " ." + TOGGLE_CONTAINER_CLASS);
  }

  function setRowChecked(marker, checked) {
    rowToggle(marker)?.classList.toggle(CHECKED_CLASS, checked);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LOCATING THE GENERAL SECTION
  // ───────────────────────────────────────────────────────────────────────────
  // General is the only part of the page with no heading — the account block and
  // the options block are both untitled, and every later section (Player,
  // Streaming, Shortcuts…) carries a title. So the General options block is the
  // last untitled section before the first titled one.
  //
  // Once found we tag it, because injectGeneralTitle() gives it a title of its
  // own and the "last untitled section" heuristic would otherwise walk past it.
  function findGeneralSection() {
    const tagged = document.querySelector("." + GENERAL_MARKER);
    if (tagged) return tagged;

    let general = null;
    for (const section of document.querySelectorAll("." + SECTION_CLASS)) {
      const title = section.querySelector("." + SECTION_TITLE_CLASS);
      if (title && !title.classList.contains(GENERAL_TITLE_MARKER)) break;
      general = section;
    }
    if (general) general.classList.add(GENERAL_MARKER);
    return general;
  }

  // Give the General section the same heading every other section has.
  function injectGeneralTitle(general) {
    if (general.querySelector("." + GENERAL_TITLE_MARKER)) return;
    const title = document.createElement("div");
    title.className = SECTION_TITLE_CLASS + " " + GENERAL_TITLE_MARKER;
    title.textContent = "General";
    general.insertBefore(title, general.firstChild);
  }

  function findNativeDiscordToggle() {
    for (const option of document.querySelectorAll("." + OPTION_CLASS)) {
      const label = option.querySelector("." + LABEL_CLASS);
      if (label?.textContent.trim() !== NATIVE_DISCORD_LABEL) continue;
      return { row: option, toggle: option.querySelector("." + TOGGLE_CONTAINER_CLASS) };
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INJECTION
  // ───────────────────────────────────────────────────────────────────────────
  function injectGamepadRow(general) {
    if (general.querySelector("." + GAMEPAD_MARKER)) return;
    general.appendChild(
      buildRow(GAMEPAD_MARKER, "Gamepad Support", gamepadEnabled, (next) => {
        gamepadEnabled = next;
        setRowChecked(GAMEPAD_MARKER, next);
        sendToShell("set-gamepad-enabled", [next ? "1" : "0"]);
      }),
    );
  }

  let discordObserver = null;
  let boundDiscordToggle = null;

  function injectDiscordRow(general) {
    const native = findNativeDiscordToggle();
    if (!native?.toggle) return;

    // React owns this div's className but not its style attribute, so an inline
    // hide survives its re-renders.
    native.row.style.display = "none";

    if (!general.querySelector("." + DISCORD_MARKER)) {
      general.appendChild(
        buildRow(
          DISCORD_MARKER,
          "Show Stremio Status on Discord",
          native.toggle.classList.contains(CHECKED_CLASS),
          // Looked up fresh: React may have replaced the node since we bound.
          () => findNativeDiscordToggle()?.toggle?.click(),
        ),
      );
    }

    if (boundDiscordToggle !== native.toggle) {
      discordObserver?.disconnect();
      boundDiscordToggle = native.toggle;
      discordObserver = new MutationObserver(syncDiscordRow);
      discordObserver.observe(native.toggle, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    syncDiscordRow();
  }

  function syncDiscordRow() {
    if (!boundDiscordToggle) return;
    setRowChecked(DISCORD_MARKER, boundDiscordToggle.classList.contains(CHECKED_CLASS));
  }

  function inject() {
    const general = findGeneralSection();
    if (!general) return;
    injectGeneralTitle(general);
    injectGamepadRow(general);
    injectDiscordRow(general);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SHELL PUSH
  // ───────────────────────────────────────────────────────────────────────────
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

    const data = msg.args[1];
    if (typeof data?.gamepadEnabled !== "boolean") return;
    gamepadEnabled = data.gamepadEnabled;
    setRowChecked(GAMEPAD_MARKER, gamepadEnabled);
  }

  function init() {
    window.chrome?.webview?.addEventListener("message", onShellMessage);

    let debounce = null;
    const observer = new MutationObserver(() => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (window.location.hash.startsWith(TARGET_ROUTE)) inject();
      }, 60);
    });

    const arm = () => {
      if (window.location.hash.startsWith(TARGET_ROUTE)) {
        inject();
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        observer.disconnect();
      }
    };

    window.addEventListener("hashchange", arm);
    arm();
    console.log("[General Shell Settings] Loaded v1.1.0");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
