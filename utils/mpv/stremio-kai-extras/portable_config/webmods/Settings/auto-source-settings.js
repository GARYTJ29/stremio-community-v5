/**
 * @name Auto Source Select Settings
 * @description Adds an "Auto Source Select" block to Settings > Player (after the
 *              Auto-Play options): the on/off toggle, where the config file is,
 *              whether it loaded, and buttons to open it.
 * @version 1.0.0
 *
 * The picker itself is UI/auto-source-select.js; its rules live in
 * portable_config/webmods/auto-source-select.config.js. Only the switch is kept
 * here (localStorage "kai-auto-source-enabled") - everything else is in the file.
 */

(function () {
  "use strict";

  if (window.AutoSourceSettings?.initialized) return;
  window.AutoSourceSettings = { initialized: true };

  const ENABLED_STORAGE = "kai-auto-source-enabled";
  const TARGET_ROUTE = "#/settings";
  const BLOCK_MARKER = "kai-auto-source-block";
  const CONFIG_REL_PATH = "webmods\\auto-source-select.config.js";
  const CONFIG_FOLDER_REL = "webmods";

  const SECTION_CLASS = "section-container-twzKQ";
  const SECTION_TITLE_CLASS = "section-title-Nt71Z";
  const CATEGORY_CLASS = "section-category-container-EOuS0";
  const OPTION_CLASS = "option-container-EGlcv";
  const NAME_CONTAINER_CLASS = "option-name-container-exGMI";
  const LABEL_CLASS = "label-FFamJ";
  const TOGGLE_CONTAINER_CLASS = "toggle-container-lZfHP";
  const INPUT_CONTAINER_CLASS = "option-input-container-NPgpT";
  const BUTTON_CONTAINER_CLASS = "button-container-zVLH6";
  const CHECKED_CLASS = "checked";

  // ───────────────────────────────────────────────────────────────────────────
  // STORAGE / SHELL
  // ───────────────────────────────────────────────────────────────────────────
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
    } catch (_) {}
    window.dispatchEvent(new Event("kai-settings-changed"));
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

  function configDir() {
    const dir = window.__shellSettings?.portableConfigDir;
    return typeof dir === "string" && dir ? dir.replace(/[\\/]+$/, "") : null;
  }

  function configLoaded() {
    const c = window.__autoSourceSelectConfig;
    return !!c && typeof c === "object";
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BUILDERS (Stremio-native classes, styled by Theme/Settings.css)
  // ───────────────────────────────────────────────────────────────────────────
  function onActivate(el, fn) {
    el.addEventListener("click", fn);
    // Gamepad "A" arrives as a synthetic Enter keydown on the focused element.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    });
  }

  function categoryHeader(label) {
    const el = document.createElement("div");
    el.className = CATEGORY_CLASS;
    el.innerHTML = `<div style="display:flex;align-items:center;color:var(--primary-foreground-color, #fff);">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="margin-right:8px;">
        <path d="M5 4.5v15l13-7.5-13-7.5z" fill="currentColor" opacity="0.9"/>
        <path d="M19 4h2v16h-2z" fill="currentColor" opacity="0.5"/></svg>
      <span class="${LABEL_CLASS}">${label}</span></div>`;
    return el;
  }

  function toggleRow(label, hint, checked, onToggle) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " kai-api-key-row";

    const nameContainer = document.createElement("div");
    nameContainer.className = NAME_CONTAINER_CLASS;
    const labelEl = document.createElement("div");
    labelEl.className = LABEL_CLASS;
    labelEl.textContent = label;
    nameContainer.appendChild(labelEl);
    if (hint) {
      const hintEl = document.createElement("div");
      hintEl.className = "kai-api-key-hint";
      hintEl.textContent = hint;
      nameContainer.appendChild(hintEl);
    }
    row.appendChild(nameContainer);

    const toggle = document.createElement("div");
    toggle.tabIndex = 0;
    toggle.className = [INPUT_CONTAINER_CLASS, TOGGLE_CONTAINER_CLASS, BUTTON_CONTAINER_CLASS].join(" ");
    toggle.classList.toggle(CHECKED_CLASS, checked);
    toggle.innerHTML = '<div class="toggle-toOWM"></div>';
    onActivate(toggle, () => {
      const next = !toggle.classList.contains(CHECKED_CLASS);
      toggle.classList.toggle(CHECKED_CLASS, next);
      onToggle(next);
    });
    row.appendChild(toggle);
    return row;
  }

  function actionButton(label, fn) {
    const b = document.createElement("div");
    b.tabIndex = 0;
    b.className = BUTTON_CONTAINER_CLASS + " kai-ass-settings-btn";
    b.textContent = label;
    onActivate(b, fn);
    return b;
  }

  function configRow() {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " kai-api-key-row";

    const dir = configDir();
    const path = dir ? dir + "\\" + CONFIG_REL_PATH : "portable_config\\" + CONFIG_REL_PATH;
    const loaded = configLoaded();

    const nameContainer = document.createElement("div");
    nameContainer.className = NAME_CONTAINER_CLASS;
    nameContainer.innerHTML = `
      <div class="${LABEL_CLASS}">Config file</div>
      <div class="kai-api-key-hint kai-ass-config-path"></div>
      <div class="kai-api-key-hint kai-ass-config-status"></div>`;
    nameContainer.querySelector(".kai-ass-config-path").textContent = path;
    nameContainer.querySelector(".kai-ass-config-status").innerHTML = loaded
      ? '<span class="kai-status-icon status-valid">✓</span> Loaded. Edit the file, then restart Stremio to apply.'
      : '<span class="kai-status-icon status-invalid">✗</span> Not loaded — the file is missing or has a syntax error (see the DevTools console). Restart Stremio after fixing it.';
    row.appendChild(nameContainer);

    if (dir) {
      const buttons = document.createElement("div");
      buttons.className = "kai-ass-settings-buttons";
      buttons.appendChild(actionButton("Open", () => sendToShell("open-config-path", [CONFIG_REL_PATH])));
      buttons.appendChild(actionButton("Folder", () => sendToShell("open-config-path", [CONFIG_FOLDER_REL])));
      row.appendChild(buttons);
    }
    return row;
  }

  function note() {
    const el = document.createElement("div");
    el.className = "description-label-h5DXc kai-info-note";
    el.innerHTML = `<svg class="kai-note-icon" viewBox="0 0 24 24" fill="none"><path d="M12 16V12M12 8H12.01M7.8 21H16.2C17.8802 21 18.7202 21 19.362 20.673C19.9265 20.3854 20.3854 19.9265 20.673 19.362C21 18.7202 21 17.8802 21 16.2V7.8C21 6.11984 21 5.27976 20.673 4.63803C20.3854 4.07354 19.9265 3.6146 19.362 3.32698C18.7202 3 17.8802 3 16.2 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V16.2C3 17.8802 3 18.7202 3.32698 19.362C3.6146 19.9265 4.07354 20.3854 4.63803 20.673C5.27976 21 6.11984 21 7.8 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Addon order, quality, language, size limits, the countdown and the wait time are all set in the config file.
      On a streams page, run <code>AutoSourceSelect.dryRun()</code> in DevTools to see how the current list would be ranked.</span>`;
    return el;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PLACEMENT
  // ───────────────────────────────────────────────────────────────────────────
  // The "Player" title heads a block that only holds Subtitles; Audio, Controls,
  // Auto-Play and Advanced follow as untitled blocks. Ours goes at the end of the
  // Auto-Play block, next to "Auto-Play Next Episode".
  function findAutoPlayBlock() {
    for (const label of document.querySelectorAll("." + CATEGORY_CLASS + " ." + LABEL_CLASS)) {
      if (label.textContent.trim() === "Auto-Play") return label.closest("." + SECTION_CLASS);
    }
    // Fallback: the last untitled block after the Player title.
    let playerTitle = null;
    for (const t of document.querySelectorAll("." + SECTION_TITLE_CLASS)) {
      if (t.textContent.trim() === "Player") {
        playerTitle = t;
        break;
      }
    }
    if (!playerTitle) return null;
    let block = playerTitle.closest("." + SECTION_CLASS);
    let last = block;
    while (block && block.nextElementSibling) {
      block = block.nextElementSibling;
      if (!block.classList.contains(SECTION_CLASS) || block.querySelector("." + SECTION_TITLE_CLASS)) break;
      last = block;
    }
    return last;
  }

  function inject() {
    if (document.querySelector("." + BLOCK_MARKER)) return;
    const target = findAutoPlayBlock();
    if (!target) return;

    const wrap = document.createElement("div");
    wrap.className = BLOCK_MARKER;
    wrap.appendChild(categoryHeader("Auto Source Select"));
    wrap.appendChild(
      toggleRow(
        "Auto-select best stream",
        "On a streams page, waits for your addons, picks the best stream by the rules in the config file and plays it after a countdown.",
        isEnabled(),
        setEnabled,
      ),
    );
    wrap.appendChild(configRow());
    wrap.appendChild(note());
    target.appendChild(wrap);
    console.log("[Auto Source Settings] Block injected");
  }

  function init() {
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
    console.log("[Auto Source Settings] Loaded v1.0.0");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
