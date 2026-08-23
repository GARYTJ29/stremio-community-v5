# Building Stremio Desktop (Windows) — Verified Steps

This is a step-by-step guide verified by actually building the project from a clean
machine (no Visual Studio, CMake, vcpkg, etc. pre-installed). It supersedes
[WINDOWS.md](WINDOWS.md) where the two disagree — a few things in that doc are stale
or machine-specific and will not work as written (noted inline below).

---

## 1. Install toolchain

Install these via [winget](https://learn.microsoft.com/windows/package-manager/winget/)
(or manually if you prefer):

```cmd
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.CMake.Project --includeRecommended"
winget install --id Kitware.CMake
winget install --id 7zip.7zip
winget install --id NSIS.NSIS
```

You also need [Node.js](https://nodejs.org/) and [Git](https://git-scm.com/download/win).

> Ninja is **not** required. `build/deploy_windows.js` configures with the
> `Visual Studio 17 2022` generator and builds via `cmake --build --config Release`
> (MSBuild), which is also what VS Code's CMake Tools extension uses by default if you
> build from the IDE instead of the CLI — both target the same `build/` directory.

## 2. Clone and get submodules

```cmd
git clone --recursive https://github.com/Zaarrg/stremio-community-v5.git
cd stremio-community-v5
```

If you cloned without `--recursive`:

```cmd
git submodule update --init --recursive
```

This populates `deps/libmpv`. **Unpack the x64 DLL manually** — it ships as a `.rar`
because of GitHub's file size limits:

```cmd
7z x deps\libmpv\x86_64\libmpv-2.dll.rar -odeps\libmpv\x86_64 -y
```

(The x86 copy under `deps/libmpv/i686` already ships unpacked.)

## 3. vcpkg

```cmd
git clone https://github.com/microsoft/vcpkg.git C:\bin\vcpkg
C:\bin\vcpkg\bootstrap-vcpkg.bat
C:\bin\vcpkg\vcpkg.exe install openssl:x64-windows-static curl:x64-windows-static nlohmann-json:x64-windows-static webview2:x64-windows-static
```

This step is slow (OpenSSL and cURL compile from source) — budget 15–30+ minutes.
For x86 builds, install the `x86-windows-static` variants instead.

`build/deploy_windows.js` defaults to `C:\bin\vcpkg`. If you cloned vcpkg somewhere
else, set the `STREMIO_VCPKG_ROOT` environment variable instead of editing the script:

```cmd
set STREMIO_VCPKG_ROOT=D:\dev\vcpkg
```

> Don't use the plain `VCPKG_ROOT` env var for this — `vcvars64.bat` (step 9) sets its
> own `VCPKG_ROOT` pointing at VS Build Tools' bundled, empty vcpkg instance, which
> would silently shadow a real install of this project's dependencies. That's exactly
> why the script reads a differently-named variable.

## 4. discord-rpc (not vendored — you must build it yourself)

`CMakeLists.txt` expects a prebuilt static `discord-rpc` at
`deps/discord-rpc/win64-static/{lib,include}` (and `win32-static` for x86), but **this
directory does not exist in the repo and there is no submodule for it** — you have to
build it from source, and the vanilla upstream library is not enough on its own.

```cmd
git clone https://github.com/discordapp/discord-rpc.git
```

`src/utils/discord.cpp` in this project uses a `type` field (for
`DISCORD_ACTIVITY_TYPE_WATCHING`) and four button fields
(`button1Label`/`button1Url`/`button2Label`/`button2Url`) on `DiscordRichPresence` that
**do not exist in upstream discord-rpc**. You must patch the library before building it:

**`include/discord_rpc.h`** — add to the struct and add the activity-type macros:

```c
typedef struct DiscordRichPresence {
    int type;                    // <-- add
    const char* state;
    const char* details;
    /* ...unchanged fields... */
    int8_t instance;
    const char* button1Label;    // <-- add
    const char* button1Url;      // <-- add
    const char* button2Label;    // <-- add
    const char* button2Url;      // <-- add
} DiscordRichPresence;

#define DISCORD_ACTIVITY_TYPE_PLAYING 0
#define DISCORD_ACTIVITY_TYPE_STREAMING 1
#define DISCORD_ACTIVITY_TYPE_LISTENING 2
#define DISCORD_ACTIVITY_TYPE_WATCHING 3
#define DISCORD_ACTIVITY_TYPE_CUSTOM 4
#define DISCORD_ACTIVITY_TYPE_COMPETING 5
```

**`src/serialization.cpp`**, inside `JsonWriteRichPresenceObj`, right after
`WriteObject activity(writer, "activity");`:

```cpp
if (presence->type) {
    WriteKey(writer, "type");
    writer.Int(presence->type);
}
```

...and right before `writer.Key("instance");`:

```cpp
if ((presence->button1Label && presence->button1Label[0] && presence->button1Url && presence->button1Url[0]) ||
    (presence->button2Label && presence->button2Label[0] && presence->button2Url && presence->button2Url[0])) {
    WriteArray buttons(writer, "buttons");
    if (presence->button1Label && presence->button1Label[0] && presence->button1Url && presence->button1Url[0]) {
        WriteObject button1(writer);
        WriteOptionalString(writer, "label", presence->button1Label);
        WriteOptionalString(writer, "url", presence->button1Url);
    }
    if (presence->button2Label && presence->button2Label[0] && presence->button2Url && presence->button2Url[0]) {
        WriteObject button2(writer);
        WriteOptionalString(writer, "label", presence->button2Label);
        WriteOptionalString(writer, "url", presence->button2Url);
    }
}
```

Also bump the CMake version requirement — discord-rpc's `cmake_minimum_required(VERSION
3.2.0)` is rejected by CMake 3.29+:

```cmake
cmake_minimum_required (VERSION 3.5)
```

Then build it as a static lib with the static CRT (matching this project's
`CMAKE_MSVC_RUNTIME_LIBRARY` setting):

```cmd
cmake -S . -B build-x64 -G "Visual Studio 17 2022" -A x64 -DBUILD_EXAMPLES=OFF -DBUILD_SHARED_LIBS=OFF -DUSE_STATIC_CRT=ON -DWARNINGS_AS_ERRORS=OFF
cmake --build build-x64 --config Release --target discord-rpc
```

Copy the result into this repo:

```cmd
mkdir deps\discord-rpc\win64-static\lib deps\discord-rpc\win64-static\include
copy build-x64\src\Release\discord-rpc.lib   deps\discord-rpc\win64-static\lib\
copy include\discord_rpc.h include\discord_register.h   deps\discord-rpc\win64-static\include\
```

(For x86, redo the same steps with `-A Win32` into `deps/discord-rpc/win32-static`.)

## 5. server.js

WINDOWS.md's documented download URL is stale/dead
(`stremio-artifacts/four/v<app-version>/server.js` doesn't exist for this fork's own
version numbers — that path is versioned by the *official Stremio server* release, not
this app's version). Use the `master` build instead:

```cmd
powershell -Command "Invoke-WebRequest -Uri https://dl.strem.io/four/master/server.js -OutFile server.js"
copy server.js utils\windows\server.js
```

## 6. NSIS NsProcess plugin (installer builds only)

```cmd
xcopy /E /I utils\windows\NsProcess\Plugin\x86-ansi     "C:\Program Files (x86)\NSIS\Plugins\x86-ansi"
xcopy /E /I utils\windows\NsProcess\Plugin\x86-unicode  "C:\Program Files (x86)\NSIS\Plugins\x86-unicode"
copy utils\windows\NsProcess\Include\nsProcess.nsh      "C:\Program Files (x86)\NSIS\Include\"
```

## 7. Fix a real CMakeLists.txt bug: missing `/EHsc`

The top-level `CMakeLists.txt` never sets `/EHsc` (MSVC's "enable C++ exceptions"
flag). This is silently masked if you configure with the **Visual Studio generator**,
because Visual Studio's own project defaults turn exceptions on regardless of what
CMake asked for. But `deploy_windows.js` configures with **`-G Ninja`**, which has no
such default — without `/EHsc`, exceptions are effectively disabled, which breaks
`wil::com_ptr` (it's gated behind `WIL_ENABLE_EXCEPTIONS`) and fails compilation of
every file that includes `core/globals.h`, with errors like:

```
error C2039: 'com_ptr': is not a member of 'wil'
```

Fix, in `CMakeLists.txt` right after `add_executable(...)`:

```cmake
add_executable(${PROJECT_NAME} WIN32 ${SOURCES})

if(MSVC)
    target_compile_options(${PROJECT_NAME} PRIVATE /EHsc)
endif()
```

## 8. Verify remaining `utils/windows` prerequisites

The deploy script also expects, already present under `utils/windows/`:

- `stremio-runtime.exe`
- `ffmpeg/` folder with `ffmpeg.exe` and its DLLs
- (For `--portable`) `WebviewRuntime/x64/EdgeWebView`, copied from an installed
  WebView2 Runtime, e.g. `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\<version>`

If any are missing, see [WINDOWS.md](WINDOWS.md) for where to source them.

## 9. Build

Run this inside the **x64 Native Tools Command Prompt for VS 2022** (or an equivalent
shell with `vcvars64.bat` sourced), with `cmake.exe` on `PATH`:

```cmd
"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
node build\deploy_windows.js --installer
```

This configures and builds into `build\` (a plain out-of-source CMake dir, `Visual
Studio 17 2022` generator, x64). It's the same directory VS Code's CMake Tools
extension uses by default, so building from the IDE (Configure, then a separate
**Build** step — they're not the same command) lands in the same place.

Other flags: `--portable` (needs 7-Zip + the WebView2 runtime folder from step 8),
`--x86` (32-bit; adjust deps paths above accordingly), `--debug`.

On success you get:

- `build\Release\stremio.exe` — the raw compiled binary
- `dist\win-x64\` — portable app folder (`stremio.exe`, `stremio-runtime.exe`,
  `server.js`, `libmpv-2.dll`, ffmpeg, `portable_config\`)
- `utils\Stremio <version>-x64.exe` — the NSIS installer (only with `--installer`)

> **Antivirus note:** on some machines, Windows Defender (or another AV) will quietly
> delete the just-created `dist\win-x64\` folder within seconds of the build finishing
> — a false-positive heuristic against a batch of freshly-written, unsigned
> executables dropped together. `build\Release\stremio.exe` and the packed NSIS
> installer are unaffected either way. If your `dist` folder keeps vanishing, check
> **Windows Security → Virus & threat protection → Protection history** and add an
> exclusion for the project folder.

> **WebView2 login/session data:** `stremio.exe.WebView2` (WebView2's Chromium profile —
> cookies, login session, cache) lives next to the exe inside `dist\win-x64`, which
> `deploy_windows.js` wipes on every build. A plain rebuild (no `--installer`/`--portable`)
> backs this folder up and restores it afterward, so you don't get logged out every time
> you iterate locally. `--installer` and `--portable` builds **skip the restore** instead,
> since both pack `dist\win-x64` wholesale into the distributable (NSIS's `File /r`, 7z's
> `\*`) — restoring it there would ship your personal login/session cookies inside the
> installer/portable archive. The backup is left parked at
> `dist\.webview2-backup-x64`; the next plain dev build picks it back up.

## 10. Clean rebuild

`build/` holds both the CMake output and the maintenance scripts
(`build_checksums.js` etc.) side by side — **never delete the whole folder**. Clear
just the generated files, plus the packaged output, then rebuild:

```cmd
cd /d C:\Projects\Stremio\stremio-community-v5
for %D in (CMakeFiles Release Debug x64 stremio.dir ALL_BUILD.dir ZERO_CHECK.dir .cmake) do if exist build\%D rmdir /s /q build\%D
del /q build\CMakeCache.txt build\*.vcxproj build\*.vcxproj.filters build\*.sln build\cmake_install.cmake 2>nul
rmdir /s /q dist 2>nul

"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
node build\deploy_windows.js
```

For Installer / Portable

```cmd
node build\deploy_windows.js --installer
```

```cmd
node build\deploy_windows.js --portable
```

This forces a full CMake reconfigure and full recompile (no incremental/stale object
files), while leaving `build_anime4k.js`, `build_animejanai.js`, `build_checksums.js`,
and `deploy_windows.js` untouched. If you only want to force recompilation without
reconfiguring (faster, keeps the existing CMakeCache), skip the `del`/first `rmdir`
line and just delete `build\Release` (or `build\Debug`) plus `dist\`.

## Summary of fixes vs. what's documented elsewhere

| Issue | Where documented (if at all) | What's actually needed |
|---|---|---|
| vcpkg path hardcoded to another dev's machine | not documented | set `STREMIO_VCPKG_ROOT` env var (step 3) |
| `discord-rpc` dependency | not documented at all | build from source + patch struct fields (step 4) |
| `server.js` download URL | WINDOWS.md, stale/dead | use `https://dl.strem.io/four/master/server.js` |
| Missing `/EHsc` under Ninja | n/a — real bug | fixed in `CMakeLists.txt` (step 7); moot now that Ninja isn't used, but the fix is harmless to keep |
| NsProcess plugin | WINDOWS.md mentions it exists, not how to install | copy into NSIS install dir (step 6) |
| Stray CMake output cluttering `build/` | not documented | see step 10 — clean only the generated files, never the whole folder |
| `dist\win-x64` disappearing after build | not documented | likely AV quarantine — see the note in step 9 |
