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
        arrowNavigation: true,
        virtualKeyboard: true
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

    // The reverse. The player immerses at once on its own container's mouseleave
    // (which also cancels the 3s re-hide timer a wake had just armed), and React
    // derives that from a bubbled mouseout whose relatedTarget lies outside the
    // container - so that is what this fakes. The bar still stays up while paused
    // or with a menu open: that is the web UI's rule, not ours.
    function sleepControls() {
        var el = playerContainer();
        if (!el) return;
        el.dispatchEvent(new MouseEvent('mouseout', {
            bubbles: true, cancelable: true, composed: true, view: window,
            relatedTarget: document.documentElement
        }));
    }

    // --- seek peek ---------------------------------------------------------
    // Seeking with the pad gives no read-out, while hovering the bar with a
    // mouse pops up the time (seekbar-hover-time webmod) and the chapter name
    // (the shell's own chapter script). Both derive everything from the
    // clientX of a mousemove on the slider, so rather than duplicating either,
    // fake a hover over the thumb and let them draw what they already would.
    var seekPeekTimer = null;

    function seekSlider() {
        var sels = ['.seek-bar-I7WeY .slider-hBDOf',
                    '[class*="seek-bar"] [class*="slider-container"]',
                    '[class*="seek-bar"] [class*="slider"]'];
        for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetParent !== null) return el;
        }
        return null;
    }

    // Where the playhead currently sits, in viewport coordinates.
    function thumbX(slider, rect) {
        var thumb = slider.querySelector('[class*="thumb-"]');
        if (thumb) {
            var tr = thumb.getBoundingClientRect();
            if (tr.width) return tr.left + tr.width / 2;
        }
        // No thumb (some themes hide it) - the filled part of the track ends
        // at the same place.
        var before = slider.querySelector('[class*="track-before"]');
        if (before) {
            var br = before.getBoundingClientRect();
            if (br.width >= 0) return rect.left + br.width;
        }
        return rect.left;
    }

    // The UI's own Slider.onMouseMove posts "seek-hover", which the shell turns
    // into a thumbfast thumbnail - unwanted here, we only asked for the text.
    // React delegates its listeners at the app root, so a bubble-phase blocker
    // on the slider's parent stops the peek short of React while the tooltip
    // listeners, which sit directly on the slider, have already run.
    function blockPeek(e) {
        if (e.__stremioPeek) e.stopPropagation();
    }

    function armPeekBlocker(slider) {
        var parent = slider.parentNode;
        if (!parent || parent.__stremioPeekBlocked) return;
        parent.__stremioPeekBlocked = true;
        parent.addEventListener('mouseover', blockPeek);
        parent.addEventListener('mousemove', blockPeek);
    }

    function peekEvent(type, init) {
        var e = new MouseEvent(type, init);
        e.__stremioPeek = true;
        return e;
    }

    function peekSeekOnce(x) {
        var slider = seekSlider();
        if (!slider) return;
        var r = slider.getBoundingClientRect();
        if (!r.width) return;
        armPeekBlocker(slider);
        var init = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: Math.round(typeof x === 'number' ? x : thumbX(slider, r)),
            clientY: Math.round(r.top + r.height / 2)
        };
        slider.dispatchEvent(peekEvent('mouseover', init));
        slider.dispatchEvent(peekEvent('mousemove', init));
    }

    // The read-out is a hover, so it has to be taken away again.
    function armPeekLeave() {
        if (seekPeekTimer) window.clearTimeout(seekPeekTimer);
        seekPeekTimer = window.setTimeout(function () {
            seekPeekTimer = null;
            var slider = seekSlider();
            // mouseleave does not bubble, but both listeners sit on the slider.
            if (slider) slider.dispatchEvent(new MouseEvent('mouseleave', {
                bubbles: false, cancelable: true, composed: true, view: window,
                relatedTarget: document.documentElement
            }));
        }, 1800);
    }

    function peekSeek() {
        // Once now so it tracks a held direction, and again once the seek has
        // landed and the thumb has actually moved.
        peekSeekOnce();
        window.setTimeout(peekSeekOnce, 180);
        armPeekLeave();
    }

)JS",
R"JS(
    // --- accel seek --------------------------------------------------------
    // A tap of left/right is the UI's own ten-second step, but a held direction
    // is someone travelling, and one press per ten seconds turns crossing an
    // hour into forty presses with a reload waited out at every one of them.
    //
    // So a held direction is driven as one long drag of the UI's own seek bar
    // instead. Slider registers its window listeners from onMouseDown there and
    // then; its mousemove only moves the label and the thumb, and the seek is
    // the single mouseup at the end. That is exactly the shape wanted here - the
    // target moves as fast as the direction is held, and the player is asked for
    // it once, when the moving stops - and it keeps the overlay honest, since the
    // UI is doing its own seeking throughout.
    //
    // The step grows with the length of the run, so a nudge is still a nudge.
    // Ten seconds is the web UI's own default for one press of an arrow.
    var SEEK_RAMP = [[3, 10], [8, 30], [15, 60]];   // [presses so far, seconds]
    var SEEK_TOP_STEP = 120;
    // A release starts this rather than committing, so that a flurry of taps is
    // one gesture and one seek instead of one reload each.
    var SEEK_TAP_MS = 350;
    // Comfortably longer than one repeat interval: this is the net for a release
    // that never lands (pad unplugged, window blurred mid-hold).
    var SEEK_IDLE_MS = 900;

    var scrub = null;
    var scrubDuration = 0;

    function parseClock(text) {
        var s = String(text || '');
        var m = s.match(/(\d+):(\d{2}):(\d{2})/) || s.match(/(\d+):(\d{2})/);
        if (!m) return -1;
        if (m.length > 3) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        return (+m[1]) * 60 + (+m[2]);
    }

    // Where we are and how long the file is, read off the seek bar's own two
    // labels - there is no <video> element to ask, mpv renders behind the page.
    // The right-hand one is a button that toggles to remaining time, hence the
    // sign check.
    function seekTimes() {
        var els = document.querySelectorAll('.seek-bar-I7WeY [class*="label-"]');
        if (els.length < 2) els = document.querySelectorAll('[class*="seek-bar"] [class*="label-"]');
        if (els.length < 2) return null;
        var at = parseClock(els[0].textContent);
        var right = String(els[1].textContent || '').trim();
        var duration = parseClock(right);
        if (at < 0 || duration < 0) return null;
        if (right.charAt(0) === '-') duration += at;
        if (duration <= 0) return null;
        return { at: at, duration: duration };
    }

    function scrubX() {
        var r = scrub.slider.getBoundingClientRect();
        if (r.width) scrub.rect = r;
        r = scrub.rect;
        return Math.round(r.left + r.width * (scrub.target / scrub.duration));
    }

    function scrubStart() {
        var slider = seekSlider();
        if (!slider) return false;
        var rect = slider.getBoundingClientRect();
        if (!rect.width) return false;
        var times = seekTimes();
        if (!times) return false;
        // The length of the file does not change, and for a second and a half
        // after a seek the left-hand label still reads the target rather than
        // where playback is - which is the one moment "duration" derived from a
        // remaining-time label would come out wrong. So it is read once.
        if (!scrubDuration) scrubDuration = times.duration;
        scrub = {
            slider: slider, rect: rect,
            y: Math.round(rect.top + rect.height / 2),
            duration: scrubDuration, target: Math.min(times.at, scrubDuration),
            dir: 0, run: 0, timer: 0
        };
        // onSlide fires with the position it is already at, so nothing moves -
        // this press is only here to open the drag.
        slider.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, composed: true, view: window,
            button: 0, buttons: 1, clientX: scrubX(), clientY: scrub.y
        }));
        return true;
    }

    function scrubStep(dir) {
        if (scrub.dir !== dir) { scrub.dir = dir; scrub.run = 0; }
        var step = SEEK_TOP_STEP;
        for (var i = 0; i < SEEK_RAMP.length; i++) {
            if (scrub.run < SEEK_RAMP[i][0]) { step = SEEK_RAMP[i][1]; break; }
        }
        scrub.run++;
        scrub.target = Math.max(0, Math.min(scrub.duration, scrub.target + dir * step));
        var x = scrubX();
        // Straight at the window, where Slider's own drag listener is: on the
        // slider it would reach React's, which posts a thumbnail request.
        window.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: false, cancelable: true, composed: true, view: window,
            button: 0, buttons: 1, clientX: x, clientY: scrub.y
        }));
        // The bar's own label already reads the target; this adds the chapter
        // name at the destination, the same as hovering there with a mouse.
        peekSeekOnce(x);
        armPeekLeave();
        if (scrub.timer) window.clearTimeout(scrub.timer);
        scrub.timer = window.setTimeout(scrubCommit, SEEK_IDLE_MS);
    }

    // Letting go does not commit outright: another press inside the grace joins
    // the same gesture, so tapping a few times over still costs one seek.
    function scrubEnd() {
        if (!scrub) return;
        if (scrub.timer) window.clearTimeout(scrub.timer);
        scrub.timer = window.setTimeout(scrubCommit, SEEK_TAP_MS);
    }

    // The one seek of the whole gesture.
    function scrubCommit() {
        if (!scrub) return;
        var s = scrub;
        scrub = null;
        if (s.timer) window.clearTimeout(s.timer);
        window.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: false, cancelable: true, composed: true, view: window,
            button: 0, buttons: 0,
            clientX: Math.round(s.rect.left + s.rect.width * (s.target / s.duration)),
            clientY: s.y
        }));
    }

    // Leaving the player takes the slider with it, so there is nothing left to
    // commit to - drop the drag rather than seeking into a view that has gone.
    function scrubDrop() {
        scrubDuration = 0;
        if (!scrub) return;
        if (scrub.timer) window.clearTimeout(scrub.timer);
        scrub = null;
    }

    function seekHeld() {
        for (var name in SEEK_BUTTONS) {
            if (held[name] && held[name].down) return true;
        }
        return false;
    }

    function playerSeek(dir) {
        if (!scrub && !scrubStart()) {
            // No seek bar to drive - fall back to the UI's own binding.
            sendKey(dir < 0 ? 'ArrowLeft' : 'ArrowRight');
            peekSeek();
            return;
        }
        scrubStep(dir);
    }

    // --- focus -------------------------------------------------------------
    var FOCUSABLE = '[tabindex]:not([tabindex="-1"]),a[href],button:not([disabled]),' +
        'input:not([disabled]),select:not([disabled]),textarea:not([disabled])';

    // Some of the web UI's Buttons carry an explicit tabindex="-1" because it
    // drives them with the mouse, which hides them from FOCUSABLE and from the
    // spatial-navigation polyfill alike. Most are better left out of reach -
    // every poster card renders its "..." menu that way, and stepping through
    // one per card would make a shelf unusable - but the back buttons are not
    // optional: the horizontal nav bar's, and the one the streams list puts
    // beside the source select, are a page's only way back short of B. So
    // directional moves search for those two as well.
    var BACK_BUTTON = '[class*="back-button-container"]';
    var NAVIGABLE = FOCUSABLE + ',' + BACK_BUTTON;

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
        // The player renders a back button of its own, and the only ring in
        // there belongs to an open menu - one stray arrow onto that button and
        // the next A leaves playback - so it stays out of the search.
        var nodes = root.querySelectorAll(inPlayer() ? FOCUSABLE : NAVIGABLE);
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
        // This listener is registered at document-created, ahead of the webmods',
        // so without this the spatial move would happen before the power dialog's
        // own capture handler ever saw the key.
        if (window.__kaiPowerMenu && window.__kaiPowerMenu.isOpen()) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        var dir = DIRECTIONS[e.key] || DIRECTIONS[e.code];
        if (!dir) return;
        // In the player the arrows are seek and volume. Nav mode does not change
        // that here: the control bar is walked by index in navMove() because its
        // buttons are not tabbable, so no arrow key is sent for it. An open menu
        // is the one case that does want the spatial search - its options are
        // ordinary tabbable Buttons.
        if (inPlayer() && !playerMenu()) return;
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
    // --- on-screen keyboard ------------------------------------------------
    // Text fields are the one thing the pad cannot reach on its own: the web UI
    // has no typing affordance short of a real keyboard. So pressing A on a
    // focused input raises a grid of keys the d-pad walks, and each press is
    // written straight into the field. It takes that deliberate press rather
    // than opening on focus, so moving the selection through a text field on the
    // way somewhere else leaves it alone.
    //
    // Rows are given as unshifted/shifted pairs of equal length, so shift is a
    // straight index swap rather than a second layout to navigate.
    var OSK_ID = 'stremio-gamepad-osk';
    var OSK_ROWS = [
        ['`1234567890-=',  '~!@#$%^&*()_+'],
        ['qwertyuiop[]\\', 'QWERTYUIOP{}|'],
        ['asdfghjkl;\'',   'ASDFGHJKL:"'],
        ['zxcvbnm,./',     'ZXCVBNM<>?']
    ];
    // The build has no /utf-8, so this file stays ASCII and the two glyphs the
    // panel shows are built from their code points instead.
    var OSK_BKSP = String.fromCharCode(0x232B);   // erase-to-the-left
    var OSK_DOT = String.fromCharCode(0x00B7);    // middle dot
    var OSK_ACTIONS = [
        { action: 'shift', label: 'Shift',  grow: 2 },
        { action: 'space', label: 'Space',  grow: 6 },
        { action: 'back',  label: OSK_BKSP, grow: 2 },
        { action: 'clear', label: 'Clear',  grow: 2 },
        { action: 'done',  label: 'Done',   grow: 2 }
    ];
    var OSK_HINT = ['A Type', 'B Close', 'X ' + OSK_BKSP, 'Y Shift',
                    'LB/RB Cursor', 'Start Done', 'Back Clear']
                   .join('  ' + OSK_DOT + '  ');

    var oskRoot = null;        // the panel itself, kept between openings
    var oskRows = [];          // [[el, ...], ...] in layout order, actions last
    var oskField = null;       // the input being typed into
    var oskRow = 1, oskCol = 0;
    var oskShift = false;
    var oskOpen = false;

    var TEXT_INPUT = /^(?:text|search|email|url|tel|password|number)$/i;

    function isTextField(el) {
        if (!el || !el.tagName) return false;
        if (el.isContentEditable) return true;
        if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
        if (el.tagName !== 'INPUT') return false;
        if (el.disabled || el.readOnly) return false;
        return TEXT_INPUT.test(el.getAttribute('type') || 'text');
    }

    function activeTextField() {
        var el = document.activeElement;
        return isTextField(el) && document.contains(el) ? el : null;
    }

    // --- writing into the field --------------------------------------------
    // React installs its own value setter on the element, so assigning .value
    // updates the DOM without the component ever hearing about it. Going through
    // the prototype setter and firing `input` is what its onChange keys off.
    function setFieldValue(el, value, caret) {
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
                                              : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        try { el.setSelectionRange(caret, caret); } catch (e) { /* type has no caret */ }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    function caretOf(el) {
        try {
            if (typeof el.selectionStart === 'number') {
                return { start: el.selectionStart, end: el.selectionEnd };
            }
        } catch (e) { /* type exposes no selection */ }
        var n = (el.value || '').length;
        return { start: n, end: n };
    }

    function fieldInsert(el, text) {
        if (el.isContentEditable) { document.execCommand('insertText', false, text); return; }
        var v = el.value || '', at = caretOf(el);
        setFieldValue(el, v.slice(0, at.start) + text + v.slice(at.end), at.start + text.length);
    }

    function fieldBackspace(el) {
        if (el.isContentEditable) { document.execCommand('delete', false, null); return; }
        var v = el.value || '', at = caretOf(el);
        if (at.end > at.start) setFieldValue(el, v.slice(0, at.start) + v.slice(at.end), at.start);
        else if (at.start > 0) setFieldValue(el, v.slice(0, at.start - 1) + v.slice(at.start), at.start - 1);
    }

    function fieldClear(el) {
        if (el.isContentEditable) {
            el.textContent = '';
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            return;
        }
        setFieldValue(el, '', 0);
    }

    function fieldMoveCaret(el, delta) {
        if (el.isContentEditable) return;
        var at = caretOf(el), n = (el.value || '').length;
        var to = Math.min(n, Math.max(0, (delta < 0 ? at.start : at.end) + delta));
        try { el.setSelectionRange(to, to); } catch (e) { /* type has no caret */ }
    }

    // --- panel -------------------------------------------------------------
    function oskStyle() {
        if (!document.head || document.getElementById(OSK_ID + '-style')) return;
        var p = '#' + OSK_ID;
        var css = p + '{position:fixed;left:50%;bottom:3rem;transform:translateX(-50%);' +
            'z-index:2147483646;display:none;flex-direction:column;gap:0.4rem;' +
            'width:min(64rem,94vw);padding:0.8rem;border-radius:0.8rem;' +
            'background:rgba(12,10,36,0.97);box-shadow:0 0.6rem 2.4rem rgba(0,0,0,0.6);' +
            'color:#fff;font-size:1.3rem;line-height:1;user-select:none}' +
            p + '.show{display:flex}' +
            p + '.top{bottom:auto;top:3rem}' +
            p + ' .osk-row{display:flex;gap:0.4rem}' +
            p + ' .osk-key{flex:1 1 0;min-width:0;height:3.4rem;display:flex;' +
            'align-items:center;justify-content:center;border-radius:0.4rem;' +
            'background:rgba(255,255,255,0.09);cursor:pointer;overflow:hidden}' +
            p + ' .osk-key.on{background:rgba(255,255,255,0.24)}' +
            p + ' .osk-key.sel{background:var(--primary-accent-color,#7b5bf5);' +
            'box-shadow:inset 0 0 0 0.2rem rgba(255,255,255,0.9)}' +
            p + ' .osk-hint{padding-top:0.3rem;text-align:center;font-size:1rem;opacity:0.55}';
        var style = document.createElement('style');
        style.id = OSK_ID + '-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    function oskKey(lower, upper, action, grow) {
        var el = document.createElement('div');
        el.className = 'osk-key';
        el.__lower = lower;
        el.__upper = upper;
        el.__action = action || '';
        el.textContent = lower;
        if (grow) el.style.flexGrow = String(grow);
        // A mouse works on it too, and must not pull focus off the field.
        el.addEventListener('mousedown', function (e) { e.preventDefault(); });
        el.addEventListener('click', function () { oskPress(el); });
        return el;
    }

    function oskBuild() {
        if (oskRoot && document.contains(oskRoot)) return true;
        if (!document.body) return false;
        oskStyle();
        oskRoot = document.createElement('div');
        oskRoot.id = OSK_ID;
        oskRoot.setAttribute('aria-hidden', 'true');
        oskRows = [];
        for (var r = 0; r < OSK_ROWS.length; r++) {
            var row = document.createElement('div');
            row.className = 'osk-row';
            var cells = [];
            var lower = OSK_ROWS[r][0], upper = OSK_ROWS[r][1];
            for (var c = 0; c < lower.length; c++) {
                var key = oskKey(lower.charAt(c), upper.charAt(c), '', 0);
                row.appendChild(key);
                cells.push(key);
            }
            oskRoot.appendChild(row);
            oskRows.push(cells);
        }
        var actions = document.createElement('div');
        actions.className = 'osk-row';
        var actionCells = [];
        for (var i = 0; i < OSK_ACTIONS.length; i++) {
            var spec = OSK_ACTIONS[i];
            var el = oskKey(spec.label, spec.label, spec.action, spec.grow);
            actions.appendChild(el);
            actionCells.push(el);
        }
        oskRoot.appendChild(actions);
        oskRows.push(actionCells);
        var hint = document.createElement('div');
        hint.className = 'osk-hint';
        hint.textContent = OSK_HINT;
        oskRoot.appendChild(hint);
        document.body.appendChild(oskRoot);
        return true;
    }

    function oskPaint() {
        for (var r = 0; r < oskRows.length; r++) {
            for (var c = 0; c < oskRows[r].length; c++) {
                var el = oskRows[r][c];
                if (!el.__action) el.textContent = oskShift ? el.__upper : el.__lower;
                else if (el.__action === 'shift') el.classList.toggle('on', oskShift);
                el.classList.toggle('sel', r === oskRow && c === oskCol);
            }
        }
    }

    // Dock to whichever half of the window the field is not in, so the panel
    // never covers what is being typed.
    function oskPlace() {
        if (!oskRoot || !oskField) return;
        var r = oskField.getBoundingClientRect();
        oskRoot.classList.toggle('top', r.top + r.height / 2 > window.innerHeight / 2);
    }

    function oskShow(field) {
        if (!CFG.virtualKeyboard || !field || !oskBuild()) return false;
        oskField = field;
        oskOpen = true;
        oskShift = false;
        if (oskRow >= oskRows.length) { oskRow = 1; oskCol = 0; }
        if (oskCol >= oskRows[oskRow].length) oskCol = 0;
        oskRoot.classList.add('show');
        oskPlace();
        oskPaint();
        return true;
    }

    // `keepField` means the user dismissed it deliberately (B, Done), so focus
    // goes back to the input - the selection carries on from the field rather
    // than from wherever it was before.
    function oskHide(keepField) {
        if (!oskOpen) return;
        oskOpen = false;
        oskShift = false;
        if (oskRoot) oskRoot.classList.remove('show');
        var field = oskField;
        oskField = null;
        if (keepField && field && document.contains(field)) focusEl(field);
    }

    // Enter is how the search box commits a query, so Done is worth more than a
    // plain dismiss.
    function oskSubmit() {
        var field = oskField;
        oskHide(true);
        if (field && document.contains(field) && document.activeElement === field) {
            sendKey('Enter');
        }
    }

    function oskMove(dir) {
        var row = oskRows[oskRow];
        if (!row || !row.length) return;
        if (dir === 'left' || dir === 'right') {
            oskCol = (oskCol + (dir === 'right' ? 1 : -1) + row.length) % row.length;
            oskPaint();
            return;
        }
        // Rows differ in length and in key width, so the column is carried across
        // by screen position rather than by index.
        var from = row[oskCol].getBoundingClientRect();
        var cx = from.left + from.width / 2;
        var next = (oskRow + (dir === 'down' ? 1 : -1) + oskRows.length) % oskRows.length;
        var best = 0, bestDist = Infinity;
        for (var i = 0; i < oskRows[next].length; i++) {
            var r = oskRows[next][i].getBoundingClientRect();
            var d = Math.abs(r.left + r.width / 2 - cx);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        oskRow = next;
        oskCol = best;
        oskPaint();
    }

    function oskTick() { rumble(20, 0.12, 0); }

    function oskPress(el) {
        var field = oskField;
        if (!field || !document.contains(field)) { oskHide(false); return; }
        if (document.activeElement !== field) focusEl(field);
        switch (el.__action) {
        case 'shift': oskShift = !oskShift; oskPaint(); return;
        case 'done':  oskSubmit(); return;
        case 'space': fieldInsert(field, ' '); break;
        case 'back':  fieldBackspace(field); break;
        case 'clear': fieldClear(field); break;
        default:
            fieldInsert(field, oskShift ? el.__upper : el.__lower);
            // Shift covers the next character only, the way a real one does.
            if (oskShift) { oskShift = false; oskPaint(); }
            break;
        }
        oskTick();
    }

    // Nearly every press while the keyboard is up belongs to it; the few that do
    // not (L3 fullscreen) fall through to the ordinary bindings.
    function oskButton(name) {
        var field = oskField;
        switch (name) {
        case 'UP':    oskMove('up'); return true;
        case 'DOWN':  oskMove('down'); return true;
        case 'LEFT':  oskMove('left'); return true;
        case 'RIGHT': oskMove('right'); return true;
        case 'A':     oskPress(oskRows[oskRow][oskCol]); return true;
        case 'B':     oskHide(true); return true;
        case 'X':     if (field) { fieldBackspace(field); oskTick(); } return true;
        case 'Y':     oskShift = !oskShift; oskPaint(); return true;
        case 'LB':    if (field) fieldMoveCaret(field, -1); return true;
        case 'RB':    if (field) fieldMoveCaret(field, 1); return true;
        case 'START': oskSubmit(); return true;
        case 'BACK':  if (field) fieldClear(field); return true;
        case 'LT': case 'RT': return true;   // no seek to do behind a text field
        default:      return false;
        }
    }

    // The keyboard only ever comes up on an explicit A press (see act()), never
    // on focus alone - walking the selection past a text field on the way to
    // something else must not pop it. Focus moving off the field is still the
    // cue to put it away.
    document.addEventListener('focusin', function (e) {
        if (oskOpen && e.target !== oskField) oskHide(false);
    }, true);

    document.addEventListener('focusout', function (e) {
        if (!oskOpen || e.target !== oskField) return;
        // A re-render can drop focus for a tick and hand it straight back.
        window.setTimeout(function () {
            if (oskOpen && document.activeElement !== oskField) oskHide(false);
        }, 0);
    }, true);
)JS",
R"JS(
    // --- control-bar nav mode ----------------------------------------------
    // The control bar renders every one of its controls as a Button carrying an
    // explicit tabindex="-1" - the web UI drives them with the mouse - so they
    // are invisible both to FOCUSABLE above and to the spatial-navigation
    // polyfill. Nav mode therefore walks the bar by index off its own selector,
    // and only hands back to the spatial path once a menu is open, whose options
    // are ordinary tabbable Buttons.
    var CONTROL_BAR = '[class*="control-bar-container"]';
    // "button-container" is the class the Button component itself renders. The
    // bar's own wrappers are "control-bar-buttonS-container" and
    // "control-bar-buttons-menu-container", so this does not catch them - but
    // the seek bar's duration label is *also* rendered as a Button (for its
    // tooltip), so scanning the whole bar picks that up as index 0 ahead of
    // play/pause. Scope to the buttons row alone to avoid it.
    var CONTROL_ITEM = '[class*="button-container"]';
    var CONTROL_BUTTONS = '[class*="control-bar-buttons-container"]';
    // Subtitles, audio, speed, cast, options and statistics each render as a
    // "menu-layer"; the episode list is a "side-drawer-layer".
    var MENU_LAYER = '[class*="menu-layer"],[class*="side-drawer-layer"]';
    var ARROWS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

    function controlBar() {
        return (playerContainer() || document).querySelector(CONTROL_BAR);
    }

    // Deliberately not isNavigable(): the whole bar sits at opacity 0 while the
    // overlay is immersed and fades in over 200ms, so a check that waited on
    // opacity would find nothing on the frame X is pressed.
    function isLaidOut(el) {
        var r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        var s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
    }

    // In bar order: play/pause first, then mute, then the menu group (speed,
    // cast, subtitles, audio, episodes, aspect ratio, options). On a narrow
    // layout that group collapses behind a single button and the rest go
    // display:none, which is why each one is checked rather than counted.
    function controlItems() {
        var out = [];
        var bar = controlBar();
        if (!bar) return out;
        var scope = bar.querySelector(CONTROL_BUTTONS) || bar;
        var nodes = scope.querySelectorAll(CONTROL_ITEM);
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].classList.contains('disabled')) continue;
            if (!isLaidOut(nodes[i])) continue;
            out.push(nodes[i]);
        }
        return out;
    }

    function playerMenu() {
        var nodes = document.querySelectorAll(MENU_LAYER);
        for (var i = 0; i < nodes.length; i++) {
            if (isVisible(nodes[i])) return nodes[i];
        }
        return null;
    }

    function focusEl(el) {
        if (!el) return false;
        try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
        return document.activeElement === el;
    }

    // Start on the option already in effect where the menu marks one, so the ring
    // lands somewhere meaningful instead of at the top of a long track list.
    function focusMenu(menu) {
        var nodes = menu.querySelectorAll(FOCUSABLE);
        var first = null;
        for (var i = 0; i < nodes.length; i++) {
            if (!isNavigable(nodes[i])) continue;
            if (nodes[i].classList.contains('selected')) return focusEl(nodes[i]);
            if (!first) first = nodes[i];
        }
        return focusEl(first);
    }

    // Put the ring somewhere to begin with - play/pause, being the first control
    // in the bar - so the first d-pad press has something to move from.
    function seedNav(attempt) {
        if (!navMode || !inPlayer()) return;
        var menu = playerMenu();
        if (menu && focusMenu(menu)) return;
        var items = controlItems();
        if (items.length && focusEl(items[0])) return;
        // The bar is only mounted while the overlay is awake, so it can still be
        // a frame or two behind the wakeControls() that preceded this.
        if (attempt < 8) window.setTimeout(function () { seedNav(attempt + 1); }, 60);
    }

    // Where the ring sits, if it is on something nav mode owns.
    function navFocus() {
        var el = document.activeElement;
        if (!el || el === document.body || !document.contains(el)) return null;
        var menu = playerMenu();
        if (menu && menu.contains(el)) return el;
        var bar = controlBar();
        return bar && bar.contains(el) ? el : null;
    }

    function navMove(dir) {
        var menu = playerMenu();
        if (menu) {
            // Menu options are tabbable, so hand over to the spatial search -
            // onArrowKey picks the key up and moves from wherever the ring is.
            if (menu.contains(document.activeElement)) sendKey(ARROWS[dir]);
            else focusMenu(menu);
            return;
        }
        var items = controlItems();
        if (!items.length) return;
        var at = -1;
        for (var i = 0; i < items.length; i++) {
            if (items[i] === document.activeElement) { at = i; break; }
        }
        if (at < 0) { focusEl(items[0]); return; }
        if (dir === 'up' || dir === 'down') {
            // The bar is a single row, so there is nothing above or below to move
            // to - leave up and down on volume, where they still do something.
            sendKey(ARROWS[dir]);
            return;
        }
        var next = at + (dir === 'right' ? 1 : -1);
        if (next >= 0 && next < items.length) focusEl(items[next]);
    }

    // In the player the d-pad is seek and volume, unless nav mode is on or a menu
    // is open - either way there is then a ring on screen to move instead. (The
    // UI disables its own seek and volume shortcuts while a menu is open anyway.)
    function playerArrow(dir) {
        if (navMode || playerMenu()) { navMove(dir); return; }
        // Left/right are the seek bindings, and seeking is a drag of the bar
        // rather than a keypress - see playerSeek.
        if (dir === 'left' || dir === 'right') { playerSeek(dir === 'left' ? -1 : 1); return; }
        sendKey(ARROWS[dir]);
    }

    // The player's Escape shortcut closes its menus *and* navigates back in the
    // same press, so B cannot use it to dismiss one. Close it the way the UI
    // itself does instead: onContainerMouseDown drops every menu unless the event
    // carries a "...ClosePrevented" flag, which only the opening button sets.
    function closePlayerMenu() {
        var el = playerContainer();
        if (!el || !playerMenu()) return false;
        var r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: Math.round(r.left + r.width / 2),
            clientY: Math.round(r.top + r.height / 2)
        }));
        // The ring was inside the menu that just went away; put it back on the bar.
        if (navMode) window.setTimeout(function () { seedNav(0); }, 120);
        return true;
    }

    function setNavMode(on) {
        navMode = !!on;
        if (navMode) {
            wakeControls();
            seedNav(0);
            return;
        }
        // Drop the ring, then let the overlay hide again rather than waiting out
        // the inactivity timer the wake at the top of act() just re-armed.
        var el = document.activeElement;
        if (el && el.blur) el.blur();
        sleepControls();
    }
)JS",
R"JS(
    // --- pad state ---------------------------------------------------------
    var BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START',
                   'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'GUIDE'];
    var REPEATABLE = { UP: 1, DOWN: 1, LEFT: 1, RIGHT: 1, LT: 1, RT: 1 };
    // The four that seek in the player, and which way. Held together they are one
    // gesture, so the drag is only committed once the last of them is let go.
    var SEEK_BUTTONS = { LEFT: -1, RIGHT: 1, LT: -1, RT: 1 };
    // Only while the on-screen keyboard is up, where these are backspace and the
    // caret keys - holding them down is the whole point.
    var OSK_REPEATABLE = { X: 1, LB: 1, RB: 1 };

    var held = {};
    var stickHeld = { UP: false, DOWN: false, LEFT: false, RIGHT: false };
    var padIndex = -1;
    var active = false;
    var rafId = 0;
    // Read fresh each tick from that frame's raw pad state (not the `held` map, which
    // is written by BUTTONS-array order and would race a same-frame RB+A press).
    var rbHeld = false;
    var lbHeld = false;
    // LB outside the player cycles tabs, but it is also half of LB+X (power menu),
    // and the cycle would fire on the way into the combo. So the press only arms
    // this; the release spends it, unless the combo cleared it first.
    var lbPending = false;
    // X toggles this in-player: while on, the d-pad walks the control bar (play,
    // mute, speed, cast, subtitles, audio...) instead of driving seek and volume.
    var navMode = false;

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
        // Every press counts as activity, whoever ends up handling it - the idle
        // watchdog in the power-menu webmod needs the ones that never become key
        // events (nav-mode moves, script-messages) as much as the ones that do.
        try { window.dispatchEvent(new CustomEvent('kai-input-activity')); } catch (e) {}
        // Anything that is not another seek ends a running one: the pending
        // position is spent before whatever was pressed gets to act on it.
        if (scrub && !SEEK_BUTTONS[name]) scrubCommit();
        // The power dialog takes the pad over the same way the keyboard does,
        // and for the same reason: in the player A is play/pause and the d-pad is
        // seek, neither of which should reach past an open dialog.
        if (window.__kaiPowerMenu && window.__kaiPowerMenu.isOpen() &&
            window.__kaiPowerMenu.pad(name)) return;
        // The on-screen keyboard takes the pad over while it is up, bar the few
        // presses it has no use for.
        if (oskOpen && oskButton(name)) return;
        var player = inPlayer();
        if (player) wakeControls();

        switch (name) {
        case 'UP':
            if (player) playerArrow('up');                         // volume up
            else if (ensureFocus()) sendKey('ArrowUp');
            break;
        case 'DOWN':
            if (player) playerArrow('down');                       // volume down
            else if (ensureFocus()) sendKey('ArrowDown');
            break;
        case 'LEFT':
            if (player) playerArrow('left');                       // seek back
            else if (ensureFocus()) sendKey('ArrowLeft');
            break;
        case 'RIGHT':
            if (player) playerArrow('right');                      // seek forward
            else if (ensureFocus()) sendKey('ArrowRight');
            break;
        case 'A':
            if (player) {
                if (rbHeld) {
                    // RB+A: skip intro/outro. Safe to send unconditionally - same
                    // "perform-skip" script-message the Tab key and the on-screen
                    // skip button send; notify_skip.lua no-ops when nothing's skippable.
                    shell('mpv-command', ['script-message-to', 'notify_skip', 'perform-skip']);
                } else if (navFocus()) {
                    // Button listens for Enter and clicks itself. This covers a
                    // menu option too, whether or not nav mode put the ring there.
                    sendKey('Enter');
                } else if (navMode) {
                    seedNav(0);                        // ring not placed yet
                } else {
                    sendKey('Space');                  // play / pause
                }
            } else if (!oskShow(activeTextField())) {
                // On a text field A raises the keyboard instead - that is how it
                // comes back after B dismissed it without leaving the field.
                if (ensureFocus()) sendKey('Enter');  // activate
            }
            break;
        case 'B':
            // Escape is back / close / exit-player on the web UI; elsewhere
            // (an addon page) nothing listens for it, so leave via history. An open
            // player menu is closed on its own first - the player's Escape would
            // otherwise close it and exit the player in the one press.
            if (player && closePlayerMenu()) break;
            if (player || isStremioUi()) sendKey('Escape');
            else window.history.back();
            break;
        case 'X':
            if (lbHeld) {
                // LB+X: power menu, in the player and out of it alike. Spending
                // the pending LB here is what stops the tab cycling underneath.
                lbPending = false;
                if (window.__kaiPowerMenu) window.__kaiPowerMenu.open();
                break;
            }
            if (player) {
                if (rbHeld) {
                    sendKey('KeyR');                    // RB+X: playback speed menu
                } else {
                    // Toggle control-bar nav mode: the d-pad walks play/mute/speed/
                    // cast/subtitles/audio/aspect/options instead of driving seek and
                    // volume. Pressing X again drops the ring and puts the overlay
                    // back to sleep.
                    setNavMode(!navMode);
                }
            } else goto('#/search');
            break;
        case 'Y':
            if (player) {
                if (rbHeld) sendKey('KeyA');            // RB+Y: audio track menu
                else sendKey('KeyS');                   // subtitles menu
            } else goto('#/');
            break;
        case 'LB':
            // Armed here, spent on release (see handleButton) so LB+X does not
            // change tabs on its way to opening the power menu. LB is not
            // repeatable, so this is exactly one cycle per tap either way.
            if (!player) lbPending = true;             // reserved in-player (no seek)
            break;
        case 'RB':
            // In-player, RB is only a modifier for RB+A (skip), RB+Y (audio), and
            // RB+X (speed); it does nothing held alone. Outside the player it still
            // cycles tabs.
            if (!player) cycleTab(1);
            break;
        case 'LT':
            if (player) playerSeek(-1);                // held = rewind
            break;
        case 'RT':
            if (player) playerSeek(1);                 // held = fast forward
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
            } else if ((REPEATABLE[name] || (oskOpen && OSK_REPEATABLE[name])) &&
                       now >= s.next) {
                s.next = now + CFG.repeatRate;
                act(name, now);
            }
        } else if (s.down) {
            s.down = false;
            // LB's tab cycle lands here rather than on the press, so that LB+X
            // can cancel it. Nothing else defers.
            if (name === 'LB' && lbPending) { lbPending = false; cycleTab(-1); }
            // Letting go of the last seek direction is what asks the player for
            // the position the drag has been building up.
            if (SEEK_BUTTONS[name] && scrub && !seekHeld()) scrubEnd();
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
        else { lbPending = false; oskHide(false); }  // nothing left to drive it with
        // Lets notify_skip.lua swap its skip-button hint between "Press Tab" and
        // "RB+A" depending on whether a pad is actually driving the player.
        shell('mpv-command', ['script-message-to', 'notify_skip', 'gamepad-active', on ? 'true' : 'false']);
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
        rbHeld = !!state.RB;
        lbHeld = !!state.LB;
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
        navMode = false;
        lbPending = false;
        oskHide(false);
    });

    // A route change drops focus, which would leave the d-pad dead until the
    // user moved a mouse. Re-seed it once the new view has rendered.
    window.addEventListener('hashchange', function () {
        playerEl = null;
        scrollCache = { el: null, at: 0 };
        navMode = false;
        scrubDrop();
        oskHide(false);
        restartRepeats();
        if (!active || inPlayer()) return;
        window.setTimeout(function () { if (active && !inPlayer()) ensureFocus(); }, 350);
    });

    window.__stremioGamepad = {
        version: 1,
        config: CFG,
        setEnabled: function (on) {
            CFG.enabled = !!on;
            if (!CFG.enabled) { held = {}; oskHide(false); setActive(false); }
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
                player: inPlayer(),
                keyboard: oskOpen
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
        << ",virtualKeyboard:" << (g_gamepadVirtualKeyboard ? "true" : "false")
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
