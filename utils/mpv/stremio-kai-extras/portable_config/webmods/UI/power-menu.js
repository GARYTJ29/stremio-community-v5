/**
 * @name Power Menu & Idle Auto-Sleep
 * @description A quit / sleep / shutdown dialog on a shortcut (Ctrl+Q) or LB+X,
 *              with an optional sleep timer and an "are you still there?" watchdog
 * @version 1.0.0
 * @author stremio-community-v5
 *
 * Two things share one dialog:
 *
 *   Power menu   - opened by the configured shortcut or by LB+X on a pad, from
 *                  the menu or from the player. Pick an action and a delay; the
 *                  choice is remembered, so the next use is "shortcut, OK".
 *   Idle watchdog - playback suppresses Windows' own idle timer, so falling
 *                  asleep mid-episode leaves the machine awake all night. After
 *                  a configurable idle period this asks, then acts.
 *
 * Quitting, suspending and shutting down are all native: the shell grew a
 * "power-action" event for them (src/utils/power.cpp). It is origin-checked on
 * the native side, so only the web UI can reach it - an addon page cannot.
 *
 * Settings live in localStorage under kai-*, written by
 * webmods/Settings/power-settings.js. Nothing here is in the .ini, because
 * nothing in C++ reads any of it.
 */

(function () {
  "use strict";

  if (window.top !== window) return;
  if (window.KaiPowerMenu && window.KaiPowerMenu.initialized) return;
  window.KaiPowerMenu = { initialized: true };

  const PLAYER_ROUTE = "#/player";
  const PAUSE_PROP = "pause";
  // Same reasoning as svp-toggle's fallback: if the web UI's own observation of
  // "pause" never reaches us, ask for it ourselves - but only once per page load,
  // since the shell re-registers with mpv on every call.
  const PAUSE_FALLBACK_MS = 15000;
  const IDLE_TICK_MS = 5000;
  const TOAST_MS = 2600;

  const KEYS = {
    shortcut: "kai-power-shortcut",
    lastAction: "kai-power-action",
    lastDelay: "kai-power-delay",
    idleEnabled: "kai-idle-enabled",
    idleScope: "kai-idle-scope",
    idleMinutes: "kai-idle-minutes",
    idlePromptSeconds: "kai-idle-prompt-seconds",
    idleAction: "kai-idle-action",
  };

  const DEFAULTS = {
    shortcut: "Ctrl+KeyQ",
    lastAction: "quit",
    lastDelay: "0",
    idleEnabled: "0",
    idleScope: "playing",
    idleMinutes: "60",
    idlePromptSeconds: "60",
    idleAction: "sleep",
  };

  const ACTIONS = [
    { id: "quit", label: "Quit Stremio" },
    { id: "sleep", label: "Sleep" },
    { id: "shutdown", label: "Shut Down" },
  ];

  // "When" is one row with an hours and a minutes field rather than a preset
  // list, so any delay can be dialled in. Both wrap: 23h steps round to 0h, 59m
  // to 0m. Zero on both means now.
  const MAX_HOURS = 24;
  const MAX_MINUTES = 60;

  // A minute per press is unusable on a pad, where a held direction repeats
  // roughly three times a second - 45 minutes would be fifteen seconds of
  // holding. So a sustained run in one direction starts moving in fives.
  const ACCEL_AFTER = 5;
  const ACCEL_WINDOW_MS = 450;
  const ACCEL_STEP = 5;

  // How long a typed digit waits for the one that would pair with it.
  const TYPE_WINDOW_MS = 1200;

  // ── storage ──────────────────────────────────────────────────────────────

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
      /* storage full or blocked */
    }
  }

  function getInt(key) {
    const n = parseInt(get(key), 10);
    return Number.isFinite(n) ? n : parseInt(DEFAULTS[key], 10);
  }

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

  // Pause first so a suspended machine wakes where it left off, and give the
  // property a moment to land before the process goes away. Quitting needs
  // neither - mpv is told to quit anyway.
  function runAction(id) {
    if (id === "quit") {
      shell("power-action", ["quit"]);
      return;
    }
    shell("mpv-set-prop", ["pause", "yes"]);
    setTimeout(() => shell("power-action", [id]), 250);
  }

  // ── time formatting ──────────────────────────────────────────────────────

  // Matches the player clock's own preference, so "Stops at" and "Ends at" never
  // disagree about the format.
  function use24Hour() {
    try {
      return localStorage.getItem("stremio-player-clock-24h") !== "false";
    } catch (e) {
      return true;
    }
  }

  function clockTime(date) {
    return new Intl.DateTimeFormat(
      undefined,
      use24Hour()
        ? { hour: "2-digit", minute: "2-digit", hour12: false }
        : { hour: "numeric", minute: "2-digit", hour12: true },
    ).format(date);
  }

  function actionLabel(id) {
    const found = ACTIONS.find((a) => a.id === id);
    return found ? found.label : id;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Rounded to the minute: this is read at a glance, and a seconds field on a
  // two-hour countdown is noise.
  function formatRemaining(ms) {
    const total = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (!hours && !minutes) return "under a minute";
    if (!hours) return minutes + "m";
    if (!minutes) return hours + "h";
    return hours + "h " + minutes + "m";
  }

  // ── toast ────────────────────────────────────────────────────────────────

  let toastEl = null;
  let toastTimer = null;

  function toast(text) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "kai-power-toast";
      document.body.appendChild(toastEl);
    }
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      if (toastEl) toastEl.classList.remove("show");
    }, TOAST_MS);
  }

  // ── timer ────────────────────────────────────────────────────────────────

  // A page reload (F5, or the shell's own reachability refresh) drops an armed
  // timer. Persisting it would mean surviving a reload only to fire while the app
  // is mid-reconnect, so it stays session-only and the toast says when it lands.
  let timerHandle = null;
  let timerAt = 0;
  let timerAction = null;

  function armTimer(action, minutes) {
    cancelTimer(true);
    if (!minutes) {
      runAction(action);
      return;
    }
    const ms = minutes * 60000;
    timerAction = action;
    timerAt = Date.now() + ms;
    timerHandle = setTimeout(() => {
      timerHandle = null;
      timerAt = 0;
      const pending = timerAction;
      timerAction = null;
      runAction(pending);
    }, ms);
    toast(
      actionLabel(action) +
        " in " +
        formatRemaining(ms) +
        " · " +
        clockTime(new Date(timerAt)),
    );
  }

  function cancelTimer(silent) {
    if (!timerHandle) return false;
    clearTimeout(timerHandle);
    timerHandle = null;
    timerAt = 0;
    timerAction = null;
    if (!silent) toast("Power timer cancelled");
    return true;
  }

  // Read by player-clock-eta.js, which shows "Stops at" in place of "Ends at"
  // when the timer lands before the video does.
  window.KaiPowerTimer = {
    stopsAt: () => (timerAt ? new Date(timerAt) : null),
    action: () => timerAction,
    isArmed: () => !!timerHandle,
    cancel: () => cancelTimer(false),
  };

  // ── shortcut matching ────────────────────────────────────────────────────

  // Stored as modifiers plus an event.code ("Ctrl+KeyQ") so the binding follows
  // the physical key rather than the keyboard layout.
  function parseShortcut(text) {
    const parts = String(text || "").split("+");
    const combo = { ctrl: false, shift: false, alt: false, code: "" };
    for (const raw of parts) {
      const part = raw.trim();
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control") combo.ctrl = true;
      else if (lower === "shift") combo.shift = true;
      else if (lower === "alt") combo.alt = true;
      else if (part) combo.code = part;
    }
    return combo.code ? combo : null;
  }

  function matchesShortcut(e) {
    const combo = parseShortcut(get("shortcut"));
    if (!combo) return false;
    if (e.metaKey) return false;
    return (
      !!e.ctrlKey === combo.ctrl &&
      !!e.shiftKey === combo.shift &&
      !!e.altKey === combo.alt &&
      e.code === combo.code
    );
  }

  // ── dialog ───────────────────────────────────────────────────────────────

  // "menu" is the power menu; "idle" is the are-you-still-there prompt. They
  // share the shell and the navigation, and differ in which rows they build.
  let mode = null;
  let root = null;
  let rows = [];
  let sel = 0;
  // Browsing moves the selection, editing changes the selected row's value, and
  // A steps between the two. Without that split left/right would mean "move" on
  // one row and "change" on the next, which is the thing a pad reads as broken.
  let editing = false;
  // Which half of a two-part value (hours / minutes) the editing row is on.
  let field = 0;
  let choiceAction = 0;
  let choiceHours = 0;
  let choiceMinutes = 0;
  let idleDeadline = 0;
  // One shared second-tick, running only while the dialog is up: the idle
  // countdown, the armed-timer chip and the "at what time" summary all want it.
  let uiTicker = null;

  // Acceleration state for the value fields, reset whenever the selection moves.
  let stepDir = 0;
  let stepRun = 0;
  let stepAt = 0;

  // The digits typed into the field being edited, and when the last one landed.
  let typeBuf = "";
  let typeAt = 0;

  function isOpen() {
    return !!mode;
  }

  function build() {
    if (root) return root;
    root = document.createElement("div");
    root.className = "kai-power-scrim";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.innerHTML =
      '<div class="kai-power-dialog">' +
      '<div class="kai-power-header">' +
      '<div class="kai-power-title"></div>' +
      '<div class="kai-power-chip kai-power-hidden"></div>' +
      "</div>" +
      '<div class="kai-power-message"></div>' +
      '<div class="kai-power-rows"></div>' +
      '<div class="kai-power-hint"></div>' +
      "</div>";
    // A click on the backdrop dismisses, the same as Cancel. Clicks inside must
    // not reach the player container, which reads a mousedown as "close every
    // menu" and would fight the dialog for the overlay.
    root.addEventListener("mousedown", (e) => e.stopPropagation());
    root.addEventListener("click", (e) => {
      if (e.target === root) close();
    });
    return root;
  }

  // data-step is the direction the value moves, not the direction the glyph
  // points, so one click path serves both shapes of arrow.
  function makeSelectorRow(label, valueText) {
    const row = document.createElement("div");
    row.className = "kai-power-row kai-power-selector";
    row.tabIndex = -1;
    row.innerHTML =
      '<span class="kai-power-label"></span>' +
      '<span class="kai-power-value">' +
      '<span class="kai-power-arrow" data-step="-1">‹</span>' +
      '<span class="kai-power-current"></span>' +
      '<span class="kai-power-arrow" data-step="1">›</span>' +
      "</span>";
    row.querySelector(".kai-power-label").textContent = label;
    row.querySelector(".kai-power-current").textContent = valueText;
    return row;
  }

  // Hours and minutes are one entry with two fields rather than two entries: the
  // selection stays on "When", left/right picks the half and up/down sets it.
  // Each half carries its own up/down stepper, which is what says which way the
  // value moves now that the row's left/right no longer does.
  function makeTimeRow(label) {
    const row = document.createElement("div");
    row.className = "kai-power-row kai-power-time";
    row.tabIndex = -1;
    const spinner = (unit) =>
      '<span class="kai-power-field">' +
      '<span class="kai-power-current">00</span>' +
      '<span class="kai-power-unit">' +
      unit +
      "</span>" +
      '<span class="kai-power-stepper">' +
      '<span class="kai-power-arrow" data-step="1">▲</span>' +
      '<span class="kai-power-arrow" data-step="-1">▼</span>' +
      "</span>" +
      "</span>";
    row.innerHTML =
      '<span class="kai-power-label"></span>' +
      '<span class="kai-power-value">' +
      spinner("h") +
      spinner("m") +
      "</span>";
    row.querySelector(".kai-power-label").textContent = label;
    return { row, fields: Array.from(row.querySelectorAll(".kai-power-field")) };
  }

  function makeButtonRow(label, primary) {
    const btn = document.createElement("div");
    btn.className = "kai-power-btn" + (primary ? " kai-power-primary" : "");
    btn.tabIndex = -1;
    btn.setAttribute("role", "button");
    btn.textContent = label;
    return btn;
  }

  function layout() {
    const container = root.querySelector(".kai-power-rows");
    container.innerHTML = "";
    rows = [];
    editing = false;
    field = 0;

    if (mode === "menu") {
      const actionRow = makeSelectorRow("Action", ACTIONS[choiceAction].label);
      container.appendChild(actionRow);
      rows.push({
        el: actionRow,
        kind: "value",
        fields: [actionRow],
        bump: (delta) => {
          stepRun = 0;
          choiceAction = wrap(choiceAction + delta, ACTIONS.length);
          actionRow.querySelector(".kai-power-current").textContent =
            ACTIONS[choiceAction].label;
          updateChrome();
        },
        // One field, so there is nothing for up/down to mean here beyond what
        // left/right already means - both walk the list.
        edit: (_axis, dir) => rows[sel].bump(dir),
        hint: "Left / Right to change · B or Enter when done",
      });

      const when = makeTimeRow("When");
      container.appendChild(when.row);

      const paintTime = () => {
        when.fields[0].querySelector(".kai-power-current").textContent =
          pad2(choiceHours);
        when.fields[1].querySelector(".kai-power-current").textContent =
          pad2(choiceMinutes);
        updateChrome();
      };
      paintTime();

      rows.push({
        el: when.row,
        kind: "value",
        fields: when.fields,
        bump: (delta) => {
          if (field === 0) {
            // Only 24 stops on the hours, so this one never needs the run-up.
            stepRun = 0;
            choiceHours = wrap(choiceHours + delta, MAX_HOURS);
            paintTime();
            return;
          }
          const dir = delta < 0 ? -1 : 1;
          choiceMinutes = wrap(
            choiceMinutes + dir * stepAmount(dir),
            MAX_MINUTES,
          );
          paintTime();
        },
        // Up is more, which is the one thing a stepper has to get right - so the
        // screen direction is inverted on its way to the value.
        edit: (axis, dir) => {
          if (axis === "h") setField(field + dir);
          else rows[sel].bump(-dir);
        },
        type: (value, digits) => {
          const max = (field === 0 ? MAX_HOURS : MAX_MINUTES) - 1;
          // A second digit that overruns the field is the start of a new value,
          // not a mistake: 2 then 5 on the hours means 5, not 25.
          if (value > max) {
            value %= 10;
            typeBuf = String(value);
            digits = 1;
          }
          if (field === 0) choiceHours = value;
          else choiceMinutes = value;
          paintTime();
          if (digits >= 2 || value * 10 > max) nextField();
        },
        hint: "Left / Right to pick · Up / Down, wheel or digits · B when done",
      });

      const buttons = document.createElement("div");
      buttons.className = "kai-power-buttons";
      container.appendChild(buttons);

      if (timerHandle) {
        const clearBtn = makeButtonRow("Cancel Timer", false);
        buttons.appendChild(clearBtn);
        rows.push({
          el: clearBtn,
          kind: "button",
          activate: () => {
            cancelTimer(false);
            close();
          },
        });
      }

      const cancel = makeButtonRow("Cancel", false);
      buttons.appendChild(cancel);
      rows.push({ el: cancel, kind: "button", activate: close });

      const ok = makeButtonRow("OK", true);
      buttons.appendChild(ok);
      rows.push({ el: ok, kind: "button", activate: commit });

      // The choice is remembered, so landing here makes a repeat use one press.
      sel = rows.length - 1;
    } else {
      const buttons = document.createElement("div");
      buttons.className = "kai-power-buttons";
      container.appendChild(buttons);

      const stay = makeButtonRow("I'm still here", true);
      buttons.appendChild(stay);
      rows.push({ el: stay, kind: "button", activate: close });

      const now = makeButtonRow(actionLabel(get("idleAction")) + " Now", false);
      buttons.appendChild(now);
      rows.push({
        el: now,
        kind: "button",
        activate: () => {
          const action = get("idleAction");
          close();
          runAction(action);
        },
      });

      sel = 0;
    }

    stepRun = 0;
    paint();
    updateChrome();
  }

  function paint() {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const on = i === sel;
      row.el.classList.toggle("selected", on);
      row.el.classList.toggle("editing", on && editing);
      if (!row.fields || row.fields.length < 2) continue;
      for (let f = 0; f < row.fields.length; f++) {
        row.fields[f].classList.toggle("active", on && editing && f === field);
      }
    }
    updateHint();
    const el = rows[sel] && rows[sel].el;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      el.focus();
    }
  }

  // The one line that says what the buttons do from here, which is what makes an
  // explicit edit mode usable on a pad rather than a thing to be discovered.
  function updateHint() {
    if (!root) return;
    const hint = root.querySelector(".kai-power-hint");
    if (!hint) return;
    const row = rows[sel];
    if (mode === "idle" || !row) {
      hint.classList.add("kai-power-hidden");
      return;
    }
    hint.classList.remove("kai-power-hidden");
    hint.textContent = editing
      ? row.hint
      : row.kind === "button"
        ? "A or Enter to select"
        : row.type
          ? "A, Enter or a digit to change"
          : "A or Enter to change";
  }

  function wrap(value, max) {
    return ((value % max) + max) % max;
  }

  function move(delta) {
    if (!rows.length) return;
    stepRun = 0;
    typeBuf = "";
    sel = wrap(sel + delta, rows.length);
    paint();
  }

  // Two fields, so this clamps rather than wraps: running off the minutes into
  // the hours would be a surprise on a press meant to be a nudge.
  function setField(next) {
    const row = rows[sel];
    if (!row || !row.fields) return;
    const at = Math.max(0, Math.min(row.fields.length - 1, next));
    if (at === field) return;
    stepRun = 0;
    typeBuf = "";
    field = at;
    paint();
  }

  function setEditing(on) {
    editing = !!on;
    if (editing) field = 0;
    stepRun = 0;
    typeBuf = "";
    paint();
  }

  // Typed digits, for the keyboard: "0" then "2" has to read as 02 rather than
  // as 0 and then 2, so the digits accumulate. The run lapses after a pause, and
  // a field that cannot take another digit hands over to the next one - typing
  // 2 3 4 5 straight through fills in 23h 45m.
  function typeDigit(digit) {
    const row = rows[sel];
    if (!row || !row.type) return;
    if (!editing) setEditing(true);
    const now = Date.now();
    if (now - typeAt > TYPE_WINDOW_MS) typeBuf = "";
    typeAt = now;
    typeBuf = (typeBuf + digit).slice(-2);
    row.type(parseInt(typeBuf, 10), typeBuf.length);
  }

  function nextField() {
    typeBuf = "";
    const row = rows[sel];
    if (row && row.fields) setField(field + 1);
  }

  // How far one press should move a value. A run of presses the same way in
  // quick succession is someone dialling a long way, not aiming at a value.
  function stepAmount(dir) {
    const now = Date.now();
    if (dir === stepDir && now - stepAt < ACCEL_WINDOW_MS) stepRun++;
    else stepRun = 1;
    stepDir = dir;
    stepAt = now;
    return stepRun > ACCEL_AFTER ? ACCEL_STEP : 1;
  }

  // Browsing, every direction moves the selection; editing, every direction is
  // the selected row's business. Neither means both things at once.
  function onDir(axis, dir) {
    const row = rows[sel];
    if (editing && row && row.edit) {
      row.edit(axis, dir);
      return;
    }
    move(dir);
  }

  function activate() {
    const row = rows[sel];
    if (!row) return;
    if (row.kind === "button") {
      row.activate();
      return;
    }
    setEditing(!editing);
  }

  // B backs out of the value it just opened, and only closes the dialog once
  // there is nothing left to back out of.
  function back() {
    if (editing) {
      setEditing(false);
      return;
    }
    close();
  }

  function commit() {
    const action = ACTIONS[choiceAction].id;
    const minutes = choiceHours * 60 + choiceMinutes;
    set("lastAction", action);
    set("lastDelay", String(minutes));
    close();
    armTimer(action, minutes);
  }

  // The chip (an armed timer's remaining time) and the summary line ("Sleep at
  // 23:45"), refreshed every second while the dialog is up.
  function updateChrome() {
    if (!root) return;
    const chip = root.querySelector(".kai-power-chip");
    const message = root.querySelector(".kai-power-message");

    if (mode === "idle") {
      chip.classList.add("kai-power-hidden");
      const left = Math.max(0, Math.ceil((idleDeadline - Date.now()) / 1000));
      message.textContent =
        actionLabel(get("idleAction")) + " in " + left + "s";
      message.classList.remove("kai-power-hidden");
      if (left > 0) return;
      const action = get("idleAction");
      close();
      runAction(action);
      return;
    }

    if (timerHandle) {
      chip.textContent =
        actionLabel(timerAction) + " in " + formatRemaining(timerAt - Date.now());
      chip.classList.remove("kai-power-hidden");
    } else {
      chip.classList.add("kai-power-hidden");
    }

    const total = choiceHours * 60 + choiceMinutes;
    message.textContent = total
      ? ACTIONS[choiceAction].label +
        " at " +
        clockTime(new Date(Date.now() + total * 60000))
      : ACTIONS[choiceAction].label + " immediately";
    message.classList.remove("kai-power-hidden");
  }

  function open() {
    if (mode === "menu") {
      close();
      return;
    }
    if (mode === "idle") close();

    choiceAction = Math.max(
      0,
      ACTIONS.findIndex((a) => a.id === get("lastAction")),
    );
    const saved = Math.max(0, Math.min(getInt("lastDelay"), MAX_HOURS * 60 - 1));
    choiceHours = Math.floor(saved / 60);
    choiceMinutes = saved % 60;

    mode = "menu";
    show("Power");
  }

  function openIdlePrompt() {
    if (mode) return;
    mode = "idle";
    idleDeadline = Date.now() + getInt("idlePromptSeconds") * 1000;
    show("Are you still there?");
  }

  function show(title) {
    const el = build();
    if (!el.isConnected) document.body.appendChild(el);
    el.querySelector(".kai-power-title").textContent = title;
    el.classList.add("show");
    layout(); // ends in updateChrome(), so the first frame is already correct
    if (uiTicker) clearInterval(uiTicker);
    uiTicker = setInterval(updateChrome, 1000);
  }

  function close() {
    if (!mode) return;
    mode = null;
    editing = false;
    field = 0;
    if (uiTicker) {
      clearInterval(uiTicker);
      uiTicker = null;
    }
    // The rows keep the ring until something else claims it, and the gamepad's
    // focus helpers would then be walking a hidden dialog.
    const focused = document.activeElement;
    if (root && focused && root.contains(focused) && focused.blur) focused.blur();
    if (root) root.classList.remove("show");
    rows = [];
    // Whatever the prompt interrupted, the user is demonstrably present now.
    noteActivity();
  }

  // ── gamepad ──────────────────────────────────────────────────────────────

  // Called from src/input/gamepad.cpp ahead of its own bindings, the same way the
  // on-screen keyboard is. Every button is consumed while the dialog is up, so
  // nothing reaches play/pause or seek behind it.
  window.__kaiPowerMenu = {
    isOpen,
    open,
    pad(name) {
      if (!mode) return false;
      if (mode === "idle") {
        // Any press answers the question; only the two buttons are navigated.
        switch (name) {
          case "LEFT":
          case "RIGHT":
          case "UP":
          case "DOWN":
            move(name === "LEFT" || name === "UP" ? -1 : 1);
            return true;
          case "A":
          case "START":
            activate();
            return true;
          default:
            close();
            return true;
        }
      }
      switch (name) {
        case "UP":
          onDir("v", -1);
          return true;
        case "DOWN":
          onDir("v", 1);
          return true;
        case "LEFT":
          onDir("h", -1);
          return true;
        case "RIGHT":
          onDir("h", 1);
          return true;
        case "A":
        case "START":
          activate();
          return true;
        case "B":
        case "BACK":
          back();
          return true;
        default:
          return true;
      }
    },
  };

  // ── keyboard ─────────────────────────────────────────────────────────────

  // Capture phase on window, ahead of the web UI's own handlers: in the player a
  // bare arrow is seek or volume and Space is play/pause, none of which may run
  // while a modal is up. gamepad.cpp's arrow listener is registered even earlier
  // and defers to isOpen() for the same reason.
  function onKeyDown(e) {
    const target = e.target;
    if (target) {
      const tag = target.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
      if (typing && !mode) return;
    }

    if (!mode) {
      if (!matchesShortcut(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open();
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    if (mode === "idle") {
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          move(-1);
          return;
        case "ArrowRight":
        case "ArrowDown":
          move(1);
          return;
        case "Enter":
          activate();
          return;
        default:
          close(); // any other key means someone is there
          return;
      }
    }

    switch (e.key) {
      case "ArrowUp":
        onDir("v", -1);
        break;
      case "ArrowDown":
        onDir("v", 1);
        break;
      case "ArrowLeft":
        onDir("h", -1);
        break;
      case "ArrowRight":
        onDir("h", 1);
        break;
      case "Enter":
      case " ":
        activate();
        break;
      case "Escape":
        back();
        break;
      case "Backspace":
      case "Delete":
        // Empties the field being typed at rather than stepping it, which is
        // what a half-typed value wants.
        if (rows[sel] && rows[sel].type) {
          typeBuf = "";
          if (!editing) setEditing(true);
          rows[sel].type(0, 1);
        }
        break;
      default:
        // A digit goes straight into the value under the selection, opening it
        // for editing on the way - typing at a field should not need a press of
        // Enter first.
        if (/^[0-9]$/.test(e.key) && rows[sel] && rows[sel].type) {
          typeDigit(e.key);
          break;
        }
        if (matchesShortcut(e)) close();
        break;
    }
  }

  // The dialog is driven by keys, but it is still clickable with a mouse.
  function onClick(e) {
    if (!mode || !root) return;
    if (!e.target || typeof e.target.closest !== "function") return;
    const at = rows.findIndex((r) => r.el === e.target || r.el.contains(e.target));
    if (at < 0) return;
    sel = at;
    const row = rows[at];
    if (row.kind === "button") {
      paint();
      row.activate();
      return;
    }
    // An arrow works its own field there and then: a mouse should not have to
    // step through the edit mode that exists for the pad's benefit.
    const arrow = e.target.closest(".kai-power-arrow");
    if (arrow) {
      aimAt(row, e.target);
      row.bump(parseInt(arrow.dataset.step, 10) || 1);
      return;
    }
    // Clicking the value itself opens the half that was clicked, so a wheel or a
    // typed digit lands where the pointer already is.
    const holder = e.target.closest(".kai-power-field");
    if (holder && row.fields && row.fields.indexOf(holder) >= 0) {
      aimAt(row, e.target);
      return;
    }
    setEditing(true);
  }

  // Point the edit at whatever the pointer is over: the row is already selected
  // by the caller, this settles which of its fields the change applies to.
  function aimAt(row, target) {
    const holder =
      target && typeof target.closest === "function"
        ? target.closest(".kai-power-field")
        : null;
    const on = holder && row.fields ? row.fields.indexOf(holder) : -1;
    editing = true;
    if (on >= 0) field = on;
    typeBuf = "";
    paint();
  }

  // The wheel is the mouse's stepper: it works the field it is over without the
  // row having to be opened first, the same shortcut the arrows take. Scrolling
  // anywhere else in the dialog is swallowed so the page behind stays put.
  function onWheel(e) {
    if (!mode || !root) return;
    e.preventDefault();
    if (mode === "idle" || !e.deltaY) return;
    const target = e.target;
    if (!target || typeof target.closest !== "function") return;
    const at = rows.findIndex((r) => r.el === target || r.el.contains(target));
    if (at < 0) return;
    const row = rows[at];
    if (!row.bump) return;
    sel = at;
    aimAt(row, target);
    row.bump(e.deltaY < 0 ? 1 : -1);
  }

  // ── idle watchdog ────────────────────────────────────────────────────────

  let lastActivity = Date.now();
  let paused = null; // null until mpv tells us
  let pauseObserved = false;
  let pauseFallbackTimer = null;

  function noteActivity() {
    lastActivity = Date.now();
  }

  function isPlayerRoute() {
    return String(window.location.hash || "").startsWith(PLAYER_ROUTE);
  }

  // Under "playing" an unknown pause state counts as playing: better to ask a
  // question that can be dismissed than to never arm at all.
  function scopeActive() {
    const scope = get("idleScope");
    if (scope === "everywhere") return true;
    if (!isPlayerRoute()) return false;
    if (scope === "player") return true;
    return paused !== true;
  }

  function idleTick() {
    if (mode === "idle") return; // already asking
    if (get("idleEnabled") !== "1") {
      noteActivity();
      return;
    }
    if (!scopeActive()) {
      noteActivity();
      return;
    }
    if (mode) return; // power menu is open, so someone is here
    const limit = Math.max(1, getInt("idleMinutes")) * 60000;
    if (Date.now() - lastActivity < limit) return;
    openIdlePrompt();
  }

  // The web UI observes "pause" for its own play button, so the change events are
  // already on the wire; asking again would make the shell register a second
  // observer and double every property change. Only fall back to asking if
  // nothing has arrived by the time the player has clearly settled.
  function armPauseFallback() {
    if (pauseFallbackTimer || pauseObserved) return;
    pauseFallbackTimer = setTimeout(() => {
      pauseFallbackTimer = null;
      if (pauseObserved) return;
      pauseObserved = true;
      shell("mpv-observe-prop", [PAUSE_PROP]);
    }, PAUSE_FALLBACK_MS);
  }

  function disarmPauseFallback() {
    if (!pauseFallbackTimer) return;
    clearTimeout(pauseFallbackTimer);
    pauseFallbackTimer = null;
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
    if (!change || change.name !== PAUSE_PROP) return;
    pauseObserved = true;
    disarmPauseFallback();
    paused = change.data === true || change.data === "yes";
  }

  function onRouteChange() {
    if (isPlayerRoute()) {
      armPauseFallback();
    } else {
      disarmPauseFallback();
      paused = null;
    }
    noteActivity();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function start() {
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    // Not passive: while the dialog is up the wheel belongs to it, not to
    // whatever is scrollable behind it.
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });

    for (const type of ["mousemove", "mousedown", "wheel", "touchstart"]) {
      window.addEventListener(
        type,
        () => {
          // A mouse twitch answers "are you still there?" too.
          if (mode === "idle") close();
          else noteActivity();
        },
        true,
      );
    }
    // Pad presses that never become key events (nav-mode moves, script-messages)
    // still count - gamepad.cpp fires this for every one of them.
    window.addEventListener("kai-input-activity", () => {
      if (mode !== "idle") noteActivity();
    });
    window.addEventListener("keydown", () => noteActivity(), true);
    window.addEventListener("hashchange", onRouteChange);

    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.addEventListener("message", onShellMessage);
    }

    setInterval(idleTick, IDLE_TICK_MS);
    onRouteChange();
    console.log("[Power Menu] Loaded v1.0.0");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
