/**
 * @name Power & Sleep Settings
 * @description Settings rows for the power menu shortcut and the idle auto-sleep
 *              watchdog in webmods/UI/power-menu.js
 * @version 1.1.0
 * @author stremio-community-v5
 *
 * Everything here is webmod-owned state, so it lives in localStorage under kai-*
 * like the rest of the Settings webmods. Nothing in C++ reads any of it - the
 * shell only ever sees the resulting "power-action" event - so there are no .ini
 * keys and no shell round-trip.
 *
 * The rows land in the General section, under a "Power & Sleep" sub-header,
 * beneath the Gamepad and Discord rows that general-shell-settings.js adds.
 */

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.KaiPowerSettings?.initialized) return;
  window.KaiPowerSettings = { initialized: true };

  const TARGET_ROUTE = "#/settings";
  const MARKER = "kai-power-setting";
  const HEADER_MARKER = "kai-power-header";

  const SECTION_CLASS = "section-container-twzKQ";
  const SECTION_TITLE_CLASS = "section-title-Nt71Z";
  const CATEGORY_CLASS = "section-category-container-EOuS0";
  const OPTION_CLASS = "option-container-EGlcv";
  const NAME_CONTAINER_CLASS = "option-name-container-exGMI";
  const LABEL_CLASS = "label-FFamJ";
  const INPUT_CONTAINER_CLASS = "option-input-container-NPgpT";
  const TOGGLE_CONTAINER_CLASS = "toggle-container-lZfHP";
  const BUTTON_CONTAINER_CLASS = "button-container-zVLH6";
  const CHECKED_CLASS = "checked";
  const DESC_STYLE =
    "color: rgba(191, 191, 191, 0.5); display: block; white-space: normal;" +
    " word-wrap: break-word; line-height: 1.4; margin-top: 0.25rem;";

  const KEYS = {
    shortcut: "kai-power-shortcut",
    idleEnabled: "kai-idle-enabled",
    idleScope: "kai-idle-scope",
    idleMinutes: "kai-idle-minutes",
    idlePromptSeconds: "kai-idle-prompt-seconds",
    idleAction: "kai-idle-action",
  };

  const DEFAULTS = {
    shortcut: "Ctrl+KeyQ",
    idleEnabled: "0",
    idleScope: "playing",
    idleMinutes: "60",
    idlePromptSeconds: "60",
    idleAction: "sleep",
  };

  const SCOPES = [
    { value: "playing", label: "Only while a video is playing" },
    { value: "player", label: "Anywhere in the player, paused or not" },
    { value: "everywhere", label: "Everywhere in the app" },
  ];

  const TIMEOUTS = [
    { value: "30", label: "30 minutes" },
    { value: "45", label: "45 minutes" },
    { value: "60", label: "1 hour" },
    { value: "90", label: "1.5 hours" },
    { value: "120", label: "2 hours" },
  ];

  const COUNTDOWNS = [
    { value: "30", label: "30 seconds" },
    { value: "60", label: "1 minute" },
    { value: "120", label: "2 minutes" },
  ];

  const IDLE_ACTIONS = [
    { value: "sleep", label: "Sleep" },
    { value: "shutdown", label: "Shut Down" },
    { value: "quit", label: "Quit Stremio" },
  ];

  // ───────────────────────────────────────────────────────────────────────────
  // STORAGE
  // ───────────────────────────────────────────────────────────────────────────

  function get(key) {
    try {
      const val = localStorage.getItem(KEYS[key]);
      return val === null || val === "" ? DEFAULTS[key] : val;
    } catch (e) {
      return DEFAULTS[key];
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(KEYS[key], String(value));
    } catch (e) {
      console.error("[Power Settings] Failed to save " + key, e);
    }
    // Same-window writes fire no "storage" event, so this is how the other
    // webmods hear about a change.
    window.dispatchEvent(new Event("kai-settings-changed"));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SHORTCUT TEXT
  // ───────────────────────────────────────────────────────────────────────────

  // Stored as modifiers plus an event.code so the binding follows the physical
  // key; shown with the code's prefix stripped, which is all a reader wants.
  function prettyShortcut(text) {
    const parts = String(text || "").split("+");
    return parts
      .map((raw) => {
        const part = raw.trim();
        if (/^Key[A-Z]$/.test(part)) return part.slice(3);
        if (/^Digit\d$/.test(part)) return part.slice(5);
        if (/^Numpad/.test(part)) return "Num " + part.slice(6);
        if (/^Arrow/.test(part)) return part.slice(5);
        return part;
      })
      .join(" + ");
  }

  // Modifier-only presses are not a binding yet, so the field keeps listening. A
  // modifier is required: the web UI binds bare letters in the player (S for
  // subtitles, A for audio, R for speed), and an unmodified binding would either
  // shadow one of those or be shadowed by it.
  function readShortcut(e) {
    const code = e.code || "";
    if (
      !code ||
      /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) ||
      code === "Escape"
    ) {
      return null;
    }
    if (!e.ctrlKey && !e.altKey && !e.shiftKey) return null;
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    parts.push(code);
    return parts.join("+");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ROW BUILDERS (Stremio-native classes, so they inherit the section styling)
  // ───────────────────────────────────────────────────────────────────────────

  function buildName(label, description) {
    const nameContainer = document.createElement("div");
    nameContainer.className = NAME_CONTAINER_CLASS;

    const labelEl = document.createElement("div");
    labelEl.className = LABEL_CLASS;
    labelEl.textContent = label;

    if (description) {
      const descEl = document.createElement("div");
      descEl.className = LABEL_CLASS;
      descEl.style.cssText = DESC_STYLE;
      descEl.textContent = description;
      labelEl.appendChild(descEl);
    }

    nameContainer.appendChild(labelEl);
    return nameContainer;
  }

  function createToggle(label, description, checked, onToggle) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " " + MARKER;
    row.appendChild(buildName(label, description));

    const toggle = document.createElement("div");
    toggle.tabIndex = 0;
    toggle.className = [
      INPUT_CONTAINER_CLASS,
      TOGGLE_CONTAINER_CLASS,
      BUTTON_CONTAINER_CLASS,
    ].join(" ");
    toggle.classList.toggle(CHECKED_CLASS, checked);
    toggle.innerHTML = '<div class="toggle-toOWM"></div>';

    const activate = () => {
      const next = !toggle.classList.contains(CHECKED_CLASS);
      toggle.classList.toggle(CHECKED_CLASS, next);
      onToggle(next);
    };
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

  function createDropdown(label, description, options, current, onChange) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " " + MARKER;
    row.appendChild(buildName(label, description));

    const dropdown = document.createElement("div");
    dropdown.className = [
      INPUT_CONTAINER_CLASS,
      "multiselect-container-w0c9l",
      "label-container-XOyzm",
      "label-container-dhjQS",
      BUTTON_CONTAINER_CLASS,
    ].join(" ");
    dropdown.tabIndex = 0;

    let index = options.findIndex((o) => o.value === current);
    if (index < 0) index = 0;

    const valueLabel = document.createElement("div");
    valueLabel.className = "label-AR_l8";
    valueLabel.textContent = options[index].label;
    dropdown.appendChild(valueLabel);

    dropdown.insertAdjacentHTML(
      "beforeend",
      '<svg class="icon-jg2il" viewBox="0 0 512 512"><path d="m91.7 213.799 145.4 169.6c2.1 2.536 4.7 4.592 7.6 6.031 2.9 1.487 6.1 2.381 9.5 2.633 3.2.251 6.5-.148 9.6-1.171 3.1-1.035 6-2.663 8.5-4.793.9-.797 1.8-1.703 2.6-2.7l145.4-169.6c3.1-3.647 4.9-8.083 5.6-12.8.7-4.719 0-9.539-1.9-13.869-2-4.344-5.2-8.023-9.2-10.599s-8.7-3.942-13.6-3.932H110.6c-3.3-.01-6.6.626-9.6 1.873-4.7 1.86-8.6 5.058-11.2 9.175-2.7 4.109-4.2 8.924-4.2 13.852.1 5.99 2.3 11.756 6.1 16.3" style="fill: currentcolor;"></path></svg>',
    );

    const menu = document.createElement("div");
    menu.className = "menu-container-B6cqK menu-direction-bottom-right-aJ89V";
    menu.setAttribute("data-focus-lock-disabled", "false");

    const inner = document.createElement("div");
    inner.className = "menu-container-qiz0X";

    options.forEach((option, at) => {
      const item = document.createElement("div");
      item.className = "option-container-mO9yW " + BUTTON_CONTAINER_CLASS;
      if (at === index) item.classList.add("selected");
      item.tabIndex = 0;
      item.title = option.label;

      const itemLabel = document.createElement("div");
      itemLabel.className = "label-AR_l8";
      itemLabel.textContent = option.label;
      item.appendChild(itemLabel);
      if (at === index) {
        const check = document.createElement("div");
        check.className = "icon-jg2il";
        item.appendChild(check);
      }

      const choose = (e) => {
        e.stopPropagation();
        valueLabel.textContent = option.label;
        inner.querySelectorAll(".option-container-mO9yW").forEach((el, idx) => {
          el.classList.toggle("selected", idx === at);
          const check = el.querySelector(".icon-jg2il");
          if (check) check.remove();
          if (idx === at) {
            const mark = document.createElement("div");
            mark.className = "icon-jg2il";
            el.appendChild(mark);
          }
        });
        dropdown.classList.remove("active");
        try {
          dropdown.focus();
        } catch (err) { }
        onChange(option.value);
      };

      item.addEventListener("click", choose);
      // The gamepad polyfill turns the A button into an Enter keypress on the
      // focused element; without this the option can be focused but not chosen.
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          choose(e);
        }
      });

      inner.appendChild(item);
    });

    menu.appendChild(inner);
    dropdown.appendChild(menu);

    const toggleMenu = () => {
      const wasActive = dropdown.classList.contains("active");
      // Every injected dropdown, not just this file's: the click is swallowed
      // here, so the other webmods' own outside-click closers never see it and
      // one of theirs would be left hanging open under this one.
      document
        .querySelectorAll(".multiselect-container-w0c9l.active")
        .forEach((el) => el.classList.remove("active"));
      dropdown.classList.toggle("active", !wasActive);
      if (!wasActive) {
        const target =
          inner.querySelector(".option-container-mO9yW.selected") ||
          inner.querySelector(".option-container-mO9yW");
        if (target) {
          try {
            target.focus();
          } catch (err) { }
        }
      }
    };

    dropdown.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleMenu();
    });

    // The gamepad polyfill delivers the A button as an Enter keypress on the
    // focused element, so the container has to open on the keyboard too.
    dropdown.addEventListener("keydown", (e) => {
      if (e.target !== dropdown) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
      } else if (e.key === "Escape" && dropdown.classList.contains("active")) {
        dropdown.classList.remove("active");
      }
    });

    row.appendChild(dropdown);
    return row;
  }

  // A text field that records the next keystroke rather than accepting typing:
  // the value is an event.code combo, which is not something anyone would want
  // to spell out by hand.
  function createShortcutCapture(label, description, current) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS + " " + MARKER;
    row.appendChild(buildName(label, description));

    const inputContainer = document.createElement("div");
    inputContainer.className = INPUT_CONTAINER_CLASS;

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.className = "kai-settings-input";
    input.value = prettyShortcut(current);
    input.title = "Click, then press the keys you want";

    let capturing = false;

    const stop = (value) => {
      capturing = false;
      input.value = prettyShortcut(value);
      input.blur();
    };

    input.addEventListener("focus", () => {
      capturing = true;
      input.value = "Press Ctrl, Alt or Shift + a key…";
    });

    input.addEventListener("blur", () => {
      if (!capturing) return;
      capturing = false;
      input.value = prettyShortcut(get("shortcut"));
    });

    // Capture phase, and swallowed outright: the power menu's own listener is on
    // window and would otherwise open the dialog while its binding is being set.
    input.addEventListener(
      "keydown",
      (e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") {
          stop(get("shortcut"));
          return;
        }
        const combo = readShortcut(e);
        if (!combo) return; // modifier on its own, keep listening
        set("shortcut", combo);
        stop(combo);
      },
      true,
    );

    inputContainer.appendChild(input);
    row.appendChild(inputContainer);
    return row;
  }

  function createHeader(label) {
    const header = document.createElement("div");
    header.className = CATEGORY_CLASS + " " + MARKER + " " + HEADER_MARKER;

    // The category container spaces its children apart, so icon and label have
    // to sit in one flex group to stay together on the left, the same way the
    // other injected Settings headers do it.
    const group = document.createElement("div");
    group.style.cssText = "display: flex; align-items: center; gap: 0.5rem;";
    group.insertAdjacentHTML(
      "beforeend",
      '<svg class="icon-REQkK" viewBox="0 0 512 512"><path d="M256 32c-13.3 0-24 10.7-24 24v200c0 13.3 10.7 24 24 24s24-10.7 24-24V56c0-13.3-10.7-24-24-24M150 108.6c-11-7.4-26-4.5-33.4 6.6C89.2 156 73 205.2 73 258c0 101.6 82.4 184 184 184s184-82.4 184-184c0-52.8-16.2-102-44-142.8-7.4-11-22.3-13.9-33.3-6.5s-13.9 22.3-6.5 33.3C379.4 175.9 393 215.4 393 258c0 75.1-60.9 136-136 136s-136-60.9-136-136c0-42.6 13.6-82.1 36.7-114.3 7.4-11 4.4-26-6.7-33.1" style="fill: currentcolor;"></path></svg>',
    );

    const labelEl = document.createElement("div");
    labelEl.className = LABEL_CLASS;
    labelEl.textContent = label;
    group.appendChild(labelEl);
    header.appendChild(group);
    return header;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INJECTION
  // ───────────────────────────────────────────────────────────────────────────

  // general-shell-settings.js owns the "last untitled section before the first
  // titled one" heuristic and exports it. The fallback covers the case where it
  // has not run yet, or has been removed from the webmods folder.
  function findGeneralSection() {
    const shared = window.GeneralShellSettings?.findGeneralSection;
    if (shared) {
      const found = shared();
      if (found) return found;
    }
    let general = null;
    for (const section of document.querySelectorAll("." + SECTION_CLASS)) {
      if (section.querySelector("." + SECTION_TITLE_CLASS)) break;
      general = section;
    }
    return general;
  }

  // The four idle rows only mean anything with the watchdog on.
  let idleRows = [];

  function setIdleRowsEnabled(enabled) {
    for (const row of idleRows) {
      row.classList.toggle("kai-disabled", !enabled);
      row.style.opacity = enabled ? "" : "0.5";
      row.style.pointerEvents = enabled ? "" : "none";
    }
  }

  function inject() {
    const general = findGeneralSection();
    if (!general) return;
    if (general.querySelector("." + HEADER_MARKER)) return;

    const fragment = document.createDocumentFragment();
    fragment.appendChild(createHeader("Power & Sleep"));

    fragment.appendChild(
      createShortcutCapture(
        "Power Menu Shortcut",
        "Opens the quit / sleep / shutdown dialog. On a controller it is LB + X.",
        get("shortcut"),
      ),
    );

    fragment.appendChild(
      createToggle(
        "Auto Sleep When Idle",
        "Playback stops Windows going to sleep on its own, so this asks first and" +
        " then acts if nobody answers.",
        get("idleEnabled") === "1",
        (next) => {
          set("idleEnabled", next ? "1" : "0");
          setIdleRowsEnabled(next);
        },
      ),
    );

    idleRows = [];
    const idle = [
      createDropdown(
        "Count Idle Time",
        "",
        SCOPES,
        get("idleScope"),
        (value) => set("idleScope", value),
      ),
      createDropdown(
        "Idle Timeout",
        "How long with no keyboard, mouse or controller input before asking.",
        TIMEOUTS,
        get("idleMinutes"),
        (value) => set("idleMinutes", value),
      ),
      createDropdown(
        '"Are you still there?" Countdown',
        "How long the prompt waits for an answer before acting.",
        COUNTDOWNS,
        get("idlePromptSeconds"),
        (value) => set("idlePromptSeconds", value),
      ),
      createDropdown(
        "Idle Action",
        "",
        IDLE_ACTIONS,
        get("idleAction"),
        (value) => set("idleAction", value),
      ),
    ];

    for (const row of idle) {
      idleRows.push(row);
      fragment.appendChild(row);
    }

    general.appendChild(fragment);
    setIdleRowsEnabled(get("idleEnabled") === "1");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

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
        idleRows = [];
      }
    };

    // Clicking anywhere else closes an open dropdown, the same as the stock ones.
    document.addEventListener("click", (e) => {
      const at = e.target;
      if (at && typeof at.closest === "function" &&
        at.closest(".multiselect-container-w0c9l")) return;
      document
        .querySelectorAll("." + MARKER + " .multiselect-container-w0c9l.active")
        .forEach((el) => el.classList.remove("active"));
    });

    window.addEventListener("hashchange", arm);
    arm();
    console.log("[Power Settings] Loaded v1.1.0");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
