#include "gamepad.h"

#include <sstream>
#include <string>

#include "../core/globals.h"
#include "../utils/helpers.h"

// ---------------------------------------------------------------------------
// Controller support.
//
// The Stremio web UI already implements every action we care about: the player
// binds its controls to keyboard shortcuts, and the bundled W3C spatial
// navigation polyfill moves DOM focus on the arrow keys. So instead of a native
// XInput poller driving mpv behind the UI's back (which would desync the
// overlay), this injects a small module that reads the Gamepad API - covering
// Xbox, DualShock/DualSense, Switch Pro and anything else Chromium maps - and
// replays it as the keys the UI already listens for.
//
// The one exception is fullscreen: requestFullscreen() needs user activation
// that a synthetic event does not carry. Exiting is fine (exitFullscreen()
// needs no gesture), but entering asks the shell to replay a real OS-level
// key press instead (see the "request-fullscreen-key" event in HandleEvent)
// so the F13 listener below can call requestFullscreen() with genuine
// activation. This keeps the page's own fullscreen state - and whatever UI
// it drives - a straight function of document.fullscreenElement either way,
// instead of a second, independently-toggled flag that can drift from it.
//
// Split across several literals to stay under the MSVC 16380-char limit for a
// single string literal.
// ---------------------------------------------------------------------------
static const char* const kGamepadJs[] = {
R"JS((function () {
    'use strict';
    if (window.top !== window) return;
    if (window.__stremioGamepad) return;
    if (!navigator.getGamepads) return;

    var CFG = {
        enabled: true,
        deadzone: 0.35,
        repeatDelay: 500,
        repeatRate: 300,
        scrollStep: 30,
        vibration: true,
        focusRing: true,
        arrowNavigation: true
    };
    var overrides = window.__STREMIO_GAMEPAD_CONFIG__ || {};
    for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) CFG[key] = overrides[key];
    }

    // --- synthetic keyboard ------------------------------------------------
    // The web UI already ships everything we need behind keyboard shortcuts
    // (player controls) and the bundled W3C spatial-navigation polyfill (menu
    // focus movement), so the pad is translated into the keys it listens for
    // instead of poking at its internals.
    function K(key, code, keyCode) { return { key: key, code: code, keyCode: keyCode }; }
    var KEYS = {
        ArrowUp: K('ArrowUp', 'ArrowUp', 38),
        ArrowDown: K('ArrowDown', 'ArrowDown', 40),
        ArrowLeft: K('ArrowLeft', 'ArrowLeft', 37),
        ArrowRight: K('ArrowRight', 'ArrowRight', 39),
        Enter: K('Enter', 'Enter', 13),
        Escape: K('Escape', 'Escape', 27),
        Space: K(' ', 'Space', 32),
        KeyA: K('a', 'KeyA', 65),
        KeyI: K('i', 'KeyI', 73),
        KeyR: K('r', 'KeyR', 82),
        KeyS: K('s', 'KeyS', 83)
    };

    function activeTarget() {
        var el = document.activeElement;
        if (el && el !== document.body && document.contains(el)) return el;
        return document.body || document.documentElement;
    }

    function sendKey(name, mods) {
        var k = KEYS[name];
        if (!k) return;
        var init = {
            key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode,
            bubbles: true, cancelable: true, composed: true, view: window,
            shiftKey: !!(mods && mods.shift), ctrlKey: !!(mods && mods.ctrl)
        };
        var el = activeTarget();
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    function shell(event, args) {
        try {
            if (!window.chrome || !window.chrome.webview) return;
            window.chrome.webview.postMessage(JSON.stringify({
                type: 6, object: 'transport', method: 'handleInboundJSON', id: 1337,
                args: [event, args || []]
            }));
        } catch (e) { /* shell not attached */ }
    }

    // Exiting never needs a gesture, so it's handled locally. Entering does,
    // so the shell is asked to replay a real key press the browser treats as
    // trusted (see the F13 listener below) - the actual requestFullscreen()
    // call happens from inside that trusted event, not here.
    function toggleFullscreen() {
        if (document.fullscreenElement) {
            var p = document.exitFullscreen();
            if (p && p.catch) p.catch(function () {});
        } else {
            shell('request-fullscreen-key');
        }
    }

    // F13 has no default binding on real keyboards, so it's safe to reserve
    // as the shell's private "enter fullscreen" signal.
    window.addEventListener('keydown', function (e) {
        if ((e.key === 'F13' || e.keyCode === 124) && !document.fullscreenElement) {
            var p = document.documentElement.requestFullscreen();
            if (p && p.catch) p.catch(function () {});
        }
    }, true);

    // --- player ------------------------------------------------------------
    var playerEl = null;

    function inPlayer() {
        return (window.location.hash || '').indexOf('#/player') === 0;
    }

    function playerContainer() {
        if (playerEl && document.contains(playerEl)) return playerEl;
        playerEl = document.querySelector('[class*="player-container"]');
        return playerEl;
    }

    // The overlay hides itself after a period of mouse inactivity; a synthetic
    // mousemove brings the control bar back so pad input stays visible.
    function wakeControls() {
        var el = playerContainer();
        if (!el) return;
        var r = el.getBoundingClientRect();
        var init = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2)
        };
        el.dispatchEvent(new MouseEvent('mouseover', init));
        el.dispatchEvent(new MouseEvent('mousemove', init));
    }

    // --- focus -------------------------------------------------------------
    var FOCUSABLE = '[tabindex]:not([tabindex="-1"]),a[href],button:not([disabled]),' +
        'input:not([disabled]),select:not([disabled]),textarea:not([disabled])';

    function isVisible(el) {
        var r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        if (r.bottom <= 0 || r.right <= 0) return false;
        if (r.top >= window.innerHeight || r.left >= window.innerWidth) return false;
        var s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) !== 0;
    }

    // Spatial navigation searches outward from the focused element; without one
    // the first d-pad press would do nothing.
    function ensureFocus() {
        var el = document.activeElement;
        if (el && el !== document.body && document.contains(el) && isVisible(el)) return true;
        var nodes = document.querySelectorAll(FOCUSABLE);
        var best = null, bestRect = null;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (n.getAttribute('aria-hidden') === 'true' || !isVisible(n)) continue;
            var r = n.getBoundingClientRect();
            if (!best || r.top < bestRect.top - 4 ||
                (Math.abs(r.top - bestRect.top) <= 4 && r.left < bestRect.left)) {
                best = n; bestRect = r;
            }
        }
        if (!best) return false;
        try { best.focus({ preventScroll: false }); } catch (e) { best.focus(); }
        return true;
    }
)JS",
R"JS(
    // --- directional focus ---------------------------------------------------
    // Arrow keys select the next item and scroll just enough to reveal it. The
    // bundled spatial-navigation polyfill does the opposite near a scrollport
    // edge: a card clipped by that edge is not one of its candidates, so it
    // scrolls the container a nudge at a time and only selects the card once it
    // happens to be fully visible. We take the arrow keys over instead.
    var DIRECTIONS = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'
    };

    function isNavigable(el) {
        if (el.getAttribute('aria-hidden') === 'true') return false;
        var r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        var s = window.getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') return false;
        return parseFloat(s.opacity) !== 0;
    }

    // Where the search may look. A `contain` element traps focus (the web UI
    // marks its dropdowns that way); a scroll container is only a first guess,
    // so reaching its edge can widen out to the rest of the page.
    function navScope(el) {
        var node = el.parentElement;
        while (node && node !== document.documentElement) {
            var s = window.getComputedStyle(node);
            if (s.getPropertyValue('--spatial-navigation-contain').trim() === 'contain') {
                return { root: node, sealed: true };
            }
            var scrolls = (node.scrollHeight - node.clientHeight > 4 &&
                           (s.overflowY === 'auto' || s.overflowY === 'scroll')) ||
                          (node.scrollWidth - node.clientWidth > 4 &&
                           (s.overflowX === 'auto' || s.overflowX === 'scroll'));
            if (scrolls) return { root: node, sealed: false };
            node = node.parentElement;
        }
        return { root: document.body || document.documentElement, sealed: true };
    }

    // Gap along the direction of travel, plus a penalty for drifting sideways,
    // so the neighbour in the same column or row wins. Negative means the
    // candidate does not qualify.
    function scoreCandidate(from, to, dir, relaxed) {
        var vertical = dir === 'up' || dir === 'down';
        var fromCx = (from.left + from.right) / 2;
        var fromCy = (from.top + from.bottom) / 2;
        var toCx = (to.left + to.right) / 2;
        var toCy = (to.top + to.bottom) / 2;

        var gap = vertical
            ? (dir === 'up' ? from.top - to.bottom : to.top - from.bottom)
            : (dir === 'left' ? from.left - to.right : to.left - from.right);
        var alongDelta = vertical
            ? (dir === 'up' ? fromCy - toCy : toCy - fromCy)
            : (dir === 'left' ? fromCx - toCx : toCx - fromCx);
        var crossDelta = vertical ? Math.abs(fromCx - toCx) : Math.abs(fromCy - toCy);

        if (relaxed) {
            // Staggered layouts, where nothing sits cleanly beyond our edge:
            // accept a candidate whose centre is further along, but only if it
            // really is more that way than sideways - otherwise pressing left
            // at the first column would jump to whatever sits above.
            if (alongDelta <= 2 || crossDelta > alongDelta) return -1;
        } else if (gap < -2) {
            return -1;
        }

        var overhang = vertical
            ? Math.max(0, Math.max(to.left, from.left) - Math.min(to.right, from.right))
            : Math.max(0, Math.max(to.top, from.top) - Math.min(to.bottom, from.bottom));
        gap = Math.max(gap, 0);
        if (gap > (vertical ? window.innerHeight : window.innerWidth) * 3) return -1;
        return gap + overhang * 3 + crossDelta * 0.2;
    }

    function pickCandidate(from, fromRect, dir, root, relaxed) {
        var nodes = root.querySelectorAll(FOCUSABLE);
        var best = null, bestScore = -1;
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el === from || el.contains(from) || from.contains(el)) continue;
            if (!isNavigable(el)) continue;
            var value = scoreCandidate(fromRect, el.getBoundingClientRect(), dir, relaxed);
            if (value < 0) continue;
            if (best === null || value < bestScore) { best = el; bestScore = value; }
        }
        return best;
    }

    // Select the neighbour in `dir`, then scroll the minimum needed to reveal
    // it - never the other way round.
    function moveFocus(dir) {
        var from = document.activeElement;
        if (!from || from === document.body || !document.contains(from)) {
            return ensureFocus();
        }
        var fromRect = from.getBoundingClientRect();
        var scope = navScope(from);
        var roots = scope.sealed ? [scope.root]
                                 : [scope.root, document.body || document.documentElement];
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i < roots.length; i++) {
                var best = pickCandidate(from, fromRect, dir, roots[i], pass === 1);
                if (!best) continue;
                try { best.focus({ preventScroll: true }); } catch (e) { best.focus(); }
                if (best.scrollIntoView) {
                    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }
                return true;
            }
        }
        return false;
    }

    // Arrow handling for the controller and the keyboard alike - the pad's
    // presses arrive here too, dispatched as ordinary arrow keydowns.
    function onArrowKey(e) {
        if (!CFG.arrowNavigation || e.defaultPrevented) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        var dir = DIRECTIONS[e.key] || DIRECTIONS[e.code];
        if (!dir) return;
        if (inPlayer()) return;                 // arrows are seek and volume there
        var el = document.activeElement;
        var tag = el && el.tagName;
        if ((tag === 'INPUT' || tag === 'TEXTAREA') && (dir === 'left' || dir === 'right')) {
            return;                             // leave the caret alone
        }
        // Claim the key so the polyfill, which checks defaultPrevented, stands
        // down. Propagation is untouched, so component handlers still see it.
        e.preventDefault();
        if (moveFocus(dir)) return;
        // Nothing focusable that way: a pane of plain text still has to scroll.
        var step = CFG.scrollStep * 3;
        var now = window.performance ? performance.now() : Date.now();
        scrollView(dir === 'left' ? -step : dir === 'right' ? step : 0,
                   dir === 'up' ? -step : dir === 'down' ? step : 0, now);
    }

    // --- navigation --------------------------------------------------------
    var TABS = ['#/', '#/discover', '#/library', '#/calendar', '#/addons', '#/settings'];

    // The module is injected into every document, including addon pages the
    // shell navigates to. Hash routing only means something on the web UI, so
    // gate it on a marker the Stremio bundle leaves behind.
    function isStremioUi() {
        return !!window.__spatialNavigation__ || !!document.querySelector('[class*="routes-container"]');
    }

    function goto(hash) {
        if (isStremioUi()) window.location.hash = hash;
    }

    function cycleTab(delta) {
        if (!isStremioUi()) return;
        var hash = window.location.hash || '#/';
        var current = 0;
        for (var i = 1; i < TABS.length; i++) {
            if (hash.indexOf(TABS[i]) === 0) current = i;
        }
        window.location.hash = TABS[(current + delta + TABS.length) % TABS.length];
    }

    // --- scrolling (right stick) -------------------------------------------
    var scrollCache = { el: null, at: 0 };

    function scrollableFrom(node, vertical) {
        while (node && node.nodeType === 1 && node !== document.documentElement) {
            var s = window.getComputedStyle(node);
            var overflow = vertical ? s.overflowY : s.overflowX;
            var slack = vertical ? node.scrollHeight - node.clientHeight
                                 : node.scrollWidth - node.clientWidth;
            if ((overflow === 'auto' || overflow === 'scroll') && slack > 4) return node;
            node = node.parentElement;
        }
        return null;
    }

    function biggestScrollable(vertical, now) {
        if (scrollCache.el && document.contains(scrollCache.el) && now - scrollCache.at < 500) {
            return scrollCache.el;
        }
        var nodes = document.querySelectorAll('div,main,section,ul');
        var best = null, bestArea = 0;
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var slack = vertical ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
            if (slack <= 4 || !isVisible(n)) continue;
            var s = window.getComputedStyle(n);
            var overflow = vertical ? s.overflowY : s.overflowX;
            if (overflow !== 'auto' && overflow !== 'scroll') continue;
            var r = n.getBoundingClientRect();
            var area = r.width * r.height;
            if (area > bestArea) { best = n; bestArea = area; }
        }
        scrollCache = { el: best, at: now };
        return best;
    }

    function scrollView(dx, dy, now) {
        var vertical = dy !== 0;
        var el = scrollableFrom(activeTarget(), vertical) || biggestScrollable(vertical, now);
        if (el) el.scrollBy(dx, dy);
        else window.scrollBy(dx, dy);
    }

    // --- chrome (focus ring + toast) ---------------------------------------
    var STYLE_ID = 'stremio-gamepad-style';
    var TOAST_ID = 'stremio-gamepad-toast';
    var ACTIVE_CLASS = 'stremio-gamepad-active';

    function injectStyle() {
        if (!document.head || document.getElementById(STYLE_ID)) return;
        var css = '#' + TOAST_ID + '{position:fixed;left:50%;bottom:4rem;' +
            'transform:translateX(-50%);z-index:2147483647;padding:0.6rem 1.4rem;' +
            'border-radius:2rem;background:rgba(12,10,36,0.92);color:#fff;' +
            'font-size:1.1rem;pointer-events:none;opacity:0;transition:opacity 0.25s ease}' +
            '#' + TOAST_ID + '.show{opacity:1}';
        if (CFG.focusRing) {
            css += 'html.' + ACTIVE_CLASS + ' :focus{' +
                'outline:0.3rem solid var(--primary-accent-color,#7b5bf5)!important;' +
                'outline-offset:-0.15rem!important}';
        }
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    var toastTimer = 0;

    function toast(text) {
        injectStyle();
        if (!document.body) return;
        var el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () { el.classList.remove('show'); }, 2200);
    }
)JS",
R"JS(
    // --- pad state ---------------------------------------------------------
    var BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START',
                   'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'GUIDE'];
    var REPEATABLE = { UP: 1, DOWN: 1, LEFT: 1, RIGHT: 1, LT: 1, RT: 1 };

    var held = {};
    var stickHeld = { UP: false, DOWN: false, LEFT: false, RIGHT: false };
    var padIndex = -1;
    var active = false;
    var rafId = 0;

    function currentPad() {
        var pads = navigator.getGamepads();
        if (!pads) return null;
        if (padIndex >= 0 && pads[padIndex] && pads[padIndex].connected) return pads[padIndex];
        for (var i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].connected) { padIndex = i; return pads[i]; }
        }
        padIndex = -1;
        return null;
    }

    function readPad(pad) {
        var state = {};
        for (var i = 0; i < BUTTONS.length; i++) {
            var b = pad.buttons[i];
            state[BUTTONS[i]] = !!(b && (b.pressed || b.value > 0.5));
        }
        var axes = pad.axes || [];
        readStick(axes.length > 0 ? axes[0] : 0, 'LEFT', 'RIGHT');
        readStick(axes.length > 1 ? axes[1] : 0, 'UP', 'DOWN');
        if (stickHeld.LEFT) state.LEFT = true;
        if (stickHeld.RIGHT) state.RIGHT = true;
        if (stickHeld.UP) state.UP = true;
        if (stickHeld.DOWN) state.DOWN = true;
        state.rx = axes.length > 2 ? axes[2] : 0;
        state.ry = axes.length > 3 ? axes[3] : 0;
        return state;
    }

    // A direction engages at the deadzone but only lets go well inside it.
    // Without that gap a stick resting near the threshold flickers, and every
    // flicker reads as a fresh press that skips the repeat delay entirely.
    function readStick(value, negative, positive) {
        var enter = CFG.deadzone;
        var exit = CFG.deadzone * 0.6;
        stickHeld[negative] = value <= -(stickHeld[negative] ? exit : enter);
        stickHeld[positive] = value >= (stickHeld[positive] ? exit : enter);
    }

    function rumble(duration, weak, strong) {
        if (!CFG.vibration) return;
        try {
            var pad = currentPad();
            if (!pad || !pad.vibrationActuator || !pad.vibrationActuator.playEffect) return;
            var result = pad.vibrationActuator.playEffect('dual-rumble', {
                startDelay: 0, duration: duration,
                weakMagnitude: weak, strongMagnitude: strong
            });
            if (result && result.catch) result.catch(function () {});
        } catch (e) { /* actuator unsupported */ }
    }

    // --- bindings ----------------------------------------------------------
    function act(name, now) {
        var player = inPlayer();
        if (player) wakeControls();

        switch (name) {
        case 'UP':
            if (player) sendKey('ArrowUp');            // volume up
            else if (ensureFocus()) sendKey('ArrowUp');
            break;
        case 'DOWN':
            if (player) sendKey('ArrowDown');          // volume down
            else if (ensureFocus()) sendKey('ArrowDown');
            break;
        case 'LEFT':
            if (player) sendKey('ArrowLeft');          // seek back
            else if (ensureFocus()) sendKey('ArrowLeft');
            break;
        case 'RIGHT':
            if (player) sendKey('ArrowRight');         // seek forward
            else if (ensureFocus()) sendKey('ArrowRight');
            break;
        case 'A':
            if (player) sendKey('Space');              // play / pause
            else if (ensureFocus()) sendKey('Enter');  // activate
            break;
        case 'B':
            // Escape is back / close / exit-player on the web UI; elsewhere
            // (an addon page) nothing listens for it, so leave via history.
            if (player || isStremioUi()) sendKey('Escape');
            else window.history.back();
            break;
        case 'X':
            if (player) sendKey('KeyS');               // subtitles menu
            else goto('#/search');
            break;
        case 'Y':
            if (player) sendKey('KeyA');               // audio track menu
            else goto('#/');
            break;
        case 'LB':
            if (player) sendKey('ArrowLeft', { shift: true });
            else cycleTab(-1);
            break;
        case 'RB':
            if (player) sendKey('ArrowRight', { shift: true });
            else cycleTab(1);
            break;
        case 'LT':
            if (player) sendKey('ArrowLeft');          // held = rewind
            break;
        case 'RT':
            if (player) sendKey('ArrowRight');         // held = fast forward
            break;
        case 'START':
            if (player) sendKey('Space');
            else goto('#/');
            break;
        case 'BACK':
            if (player) sendKey('KeyI');               // episode / info drawer
            else sendKey('Escape');
            break;
        case 'L3':
            toggleFullscreen();
            break;
        case 'R3':
            if (player) sendKey('KeyR');               // playback speed menu
            break;
        default:
            break;
        }
    }

    function handleButton(name, down, now) {
        var s = held[name];
        if (!s) s = held[name] = { down: false, next: 0 };
        if (down) {
            if (!s.down) {
                s.down = true;
                s.next = now + CFG.repeatDelay;
                act(name, now);
            } else if (REPEATABLE[name] && now >= s.next) {
                s.next = now + CFG.repeatRate;
                act(name, now);
            }
        } else if (s.down) {
            s.down = false;
        }
    }

    // Give a still-held direction the full delay again after a route change, so
    // one press moves one step instead of running away through the new view.
    function restartRepeats() {
        var now = window.performance ? performance.now() : Date.now();
        for (var name in held) {
            if (held[name].down) held[name].next = now + CFG.repeatDelay;
        }
    }

    function handleScroll(state, now) {
        if (inPlayer()) return;
        var dz = CFG.deadzone;
        var dx = Math.abs(state.rx) > dz ? state.rx * CFG.scrollStep : 0;
        var dy = Math.abs(state.ry) > dz ? state.ry * CFG.scrollStep : 0;
        if (!dx && !dy) return;
        scrollView(dx, dy, now);
    }

    function setActive(on) {
        if (on === active) return;
        active = on;
        var root = document.documentElement;
        if (root && root.classList) root.classList.toggle(ACTIVE_CLASS, on);
        if (on) toast('Controller connected');
    }

    function tick() {
        rafId = window.requestAnimationFrame(tick);
        if (!CFG.enabled) {
            if (active) { held = {}; setActive(false); }
            return;
        }
        var pad = currentPad();
        if (!pad) {
            if (active) { held = {}; setActive(false); }
            return;
        }
        if (!active) setActive(true);

        var now = window.performance ? performance.now() : Date.now();
        var state = readPad(pad);
        for (var i = 0; i < BUTTONS.length; i++) {
            handleButton(BUTTONS[i], !!state[BUTTONS[i]], now);
        }
        handleScroll(state, now);
    }

    // Capture phase, so this runs ahead of the polyfill's own window listener.
    window.addEventListener('keydown', onArrowKey, true);

    function start() {
        injectStyle();
        if (!rafId) rafId = window.requestAnimationFrame(tick);
    }

    window.addEventListener('gamepadconnected', function (e) {
        if (e.gamepad) padIndex = e.gamepad.index;
        start();
        rumble(160, 0.35, 0.15);
    });

    window.addEventListener('gamepaddisconnected', function () {
        padIndex = -1;
        held = {};
    });

    // A route change drops focus, which would leave the d-pad dead until the
    // user moved a mouse. Re-seed it once the new view has rendered.
    window.addEventListener('hashchange', function () {
        playerEl = null;
        scrollCache = { el: null, at: 0 };
        restartRepeats();
        if (!active || inPlayer()) return;
        window.setTimeout(function () { if (active && !inPlayer()) ensureFocus(); }, 350);
    });

    window.__stremioGamepad = {
        version: 1,
        config: CFG,
        setEnabled: function (on) {
            CFG.enabled = !!on;
            if (!CFG.enabled) { held = {}; setActive(false); }
            return CFG.enabled;
        },
        isEnabled: function () { return !!CFG.enabled; },
        status: function () {
            var pad = currentPad();
            return {
                enabled: !!CFG.enabled,
                connected: !!pad,
                id: pad ? pad.id : null,
                mapping: pad ? pad.mapping : null,
                player: inPlayer()
            };
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
)JS",
};

std::wstring BuildGamepadScript()
{
    std::ostringstream cfg;
    cfg << "window.__STREMIO_GAMEPAD_CONFIG__={"
        << "enabled:"     << (g_gamepadEnabled ? "true" : "false")
        // Kept as a percentage in the .ini so no float formatting is needed here.
        << ",deadzone:"   << g_gamepadDeadzone << "/100"
        << ",repeatDelay:" << g_gamepadRepeatDelay
        << ",repeatRate:"  << g_gamepadRepeatRate
        << ",vibration:"  << (g_gamepadVibration ? "true" : "false")
        << ",focusRing:"  << (g_gamepadFocusRing ? "true" : "false")
        << ",arrowNavigation:" << (g_gamepadArrowNav ? "true" : "false")
        << "};";

    std::string js = cfg.str();
    for (const char* part : kGamepadJs) js += part;
    return Utf8ToWstring(js);
}

void ApplyGamepadEnabled()
{
    if (!g_webview) return;
    std::wstring script = L"window.__stremioGamepad&&window.__stremioGamepad.setEnabled(";
    script += g_gamepadEnabled ? L"true" : L"false";
    script += L");";
    g_webview->ExecuteScript(script.c_str(), nullptr);
}
