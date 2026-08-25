## 🎬 Stremio Ready-to-Go Portable Configs for MPV

### 🎥 Anime4K
- ✅ **No Special Configuration Needed**
- 📦 Auto-attached by `build/deploy_windows.js` on every `dist\win` build (source: `utils/mpv/anime4k/portable_config`).



### 📸 ThumbFast
- ✅ **No Special Configuration Needed**
- 📦 Auto-attached by `build/deploy_windows.js` on every `dist\win` build: `thumbfast.7z` (kept zipped since it bundles a standalone `mpv.exe`, ~113MB unpacked, which ThumbFast spawns to render thumbnails) is extracted straight into `dist\win-*\portable_config`. Its bundled `stremio-settings.ini` sets `ThumbFastHeight=110`, so previews are on by default.
- ⚙️ **Configuration Tip:** If you change the ``max-height`` in ``thumbfast.conf``, ensure you also update it in ``stremio-settings.ini``. Set it to `0` to disable ThumbFast handling.

### 🧩 Stremio-Kai Extras
- 📦 Auto-attached by `build/deploy_windows.js` on every `dist\win` build (source: `utils/mpv/stremio-kai-extras/portable_config`). Trimmed down from [Stremio-Kai](https://github.com/allecsc/Stremio-Kai) to just the pieces below — the rest of that project (HDR/anime shader-profile switching, TMDB/MDBList metadata hover cards, Smart Track Selector, etc.) was left out.
- ✅ **No Special Configuration Needed** — Player Clock & ETA Display (`webmods/UI/player-clock-eta.*`), Seek Bar Time Tooltip (`webmods/UI/seekbar-hover-time.*`), and notify_skip (`scripts/notify_skip/`, chapter/silence/black-frame based skip-intro/outro notifications) all work out of the box. notify_skip's content-type detection is fed by a small standalone bridge (`webmods/notify-skip-bridge/`: `route-detector.js` + `mpv-bridge.js`, lifted out of Stremio-Kai's much larger Metadata subsystem) — it does **not** pull in TMDB/MDBList fetching. The Skip Intro/Outro button itself is an mpv ASS overlay, not a real clickable element, so `webmods/notify-skip-bridge/skip-button-click.js` (also extracted, from Kai's `navigation.js`) mirrors skip-toast.lua's on-screen button position and forwards clicks there to mpv — without it, clicking the button just falls through to Stremio's player and toggles play/pause. notify_skip's optional IntroDB online lookup needs a bundled `python.exe`, which isn't included, so it silently no-ops; chapter- and filter-based detection still work. Gamepad support for the skip button is not wired up yet — every in-player button is already mapped in `src/input/gamepad.cpp` and needs a deliberate choice of what to give up, so it's on hold pending a proper redesign rather than an ad-hoc rebind.
- ⚙️ **Requires SVP4/VapourSynth installed separately:** `svp_anime.vpy` / `svp_cinema.vpy` (`script-opts/svp.conf` tunes threads/cache), `scripts/reactive_vf_bypass.lua` (pauses the SVP filter during seeks for responsiveness), and `scripts/svp_cleanup.lua` (forces SVP/VapourSynth to tear down between files) are dropped in but **dormant** until you add a `vf-add=vapoursynth=[...svp_anime.vpy...]` (or `svp_cinema.vpy`) line yourself, e.g. via `input.conf`/`mpv.conf` — this repo doesn't ship the profile-switching glue that would wire it up automatically. The VF-bypass and cleanup scripts only act once they see a filter labeled `SVP` or named `vapoursynth` in the chain.
- 🔀 **SVP can be toggled mid-playback:** an `SVP` button sits in the player control bar (`webmods/UI/svp-toggle.*`), with `Ctrl+S` as a shortcut. It sends `toggle-svp` to `scripts/profile-manager.lua`, which adds or removes the `@SVP` filter and swaps the sync policy with it. The button reads its state back from the `user-data/kai/svp` property rather than assuming, so it stays right when SVP is flipped elsewhere or a `.vpy` fails to load, and it hides itself when VapourSynth is missing. The switch lasts for the current video only — the Settings toggle stays the default for the next one.


### 🎨 AnimeJaNai
- ✅ **Optimized for Stremio**
- 📥 Download the custom build of ``stremio-animejanai`` from the [Releases Tab](https://github.com/Zaarrg/stremio-desktop-v5/releases)
  - 🛠️ **Changes Made**:
    - ❌ Removed `mpvnet.exe` since Stremio serves as the player.
    - 🔧 Adjusted ``mpv.conf`` to work seamlessly with Stremio.
    - 🔧 Updated ``input.conf`` for compatibility with Stremio.