# URLopen

Point the local build at `stremio://` links, and bulk-open addon manifest URLs.

`dist\win-x64\stremio.exe` already knows how to handle a `stremio://` (or
`magnet:`) argument on the command line and forwards it to a running instance
via `WM_COPYDATA` (see [`src/ui/mainwindow.cpp`](../../src/ui/mainwindow.cpp)).
It just isn't wired up as the system handler unless you run the NSIS installer.
`URLopen.ps1` does that wiring against the repo's dist folder, and can also feed
a list of URLs to the app.

## Register the handler

```powershell
.\URLopen.ps1 -Register          # stremio:// only
.\URLopen.ps1 -Register -Magnet   # also magnet:
```

Writes per-user keys under `HKCU\Software\Classes\stremio` pointing at
`..\..\dist\win-x64\stremio.exe` (override with `-Target <path>`). No admin
rights needed. After this, clicking a `stremio://` link anywhere on Windows
opens this build.

Undo with `.\URLopen.ps1 -Unregister` (add `-Magnet` to also drop that key).

> Re-run `-Register` after moving the repo or if an installed Stremio steals the
> association back.

## Open addon URLs

`http(s)://` is rewritten to `stremio://` automatically, so an addon's plain
manifest URL works:

```powershell
.\URLopen.ps1 -Open https://rating-aggregator.elfhosted.com/manifest.json
.\URLopen.ps1 -Open url1 url2 url3
```

From a file (one URL per line, blank lines and `#` comments ignored):

```powershell
.\URLopen.ps1 -File ..\..\deps\Stremio-Kai-main\manifest_urls
```

Each URL is handed to the app in turn with a `-Delay` (default 1.5s) pause
between them. Start Stremio first; each `stremio://.../manifest.json` opens the
addon-install prompt.
