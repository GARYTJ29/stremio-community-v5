<#
.SYNOPSIS
    Make the local build (dist\win-x64\stremio.exe) the Windows handler for
    stremio:// links, and optionally fire a batch of addon manifest URLs at it.

.DESCRIPTION
    -Register writes the per-user URL-protocol keys under
    HKCU\Software\Classes\stremio (and, with -Magnet, HKCU\Software\Classes\magnet)
    so every stremio:// link opens in this build instead of an installed copy of
    Stremio. This mirrors what the NSIS installer does, just pointed at the repo's
    dist folder. No admin rights needed - it is all HKCU.

    -Open feeds one or more URLs straight to the exe (the running instance picks
    them up via WM_COPYDATA). http(s):// links are rewritten to stremio:// first,
    so an addon's plain manifest URL works as-is:
        https://rating-aggregator.elfhosted.com/manifest.json
        -> stremio://rating-aggregator.elfhosted.com/manifest.json

    -File reads URLs from a text file, one per line (blank lines and lines
    starting with # are ignored) - handy for a manifest_urls list.

.EXAMPLE
    .\URLopen.ps1 -Register

.EXAMPLE
    .\URLopen.ps1 -Open https://rating-aggregator.elfhosted.com/manifest.json

.EXAMPLE
    .\URLopen.ps1 -File ..\..\deps\Stremio-Kai-main\manifest_urls

.EXAMPLE
    .\URLopen.ps1 -Unregister
#>
[CmdletBinding()]
param(
    # Write the protocol-handler registry keys.
    [switch]$Register,

    # Remove the protocol-handler registry keys.
    [switch]$Unregister,

    # One or more URLs to hand to the app now. http(s):// is rewritten to stremio://.
    [string[]]$Open,

    # Path to a text file of URLs (one per line, # for comments).
    [string]$File,

    # Target executable. Defaults to the repo's dist\win-x64\stremio.exe.
    [string]$Target,

    # Also (un)register the magnet: protocol.
    [switch]$Magnet,

    # Seconds to wait between URLs when batching (gives the app time to react).
    [double]$Delay = 1.5
)

$ErrorActionPreference = 'Stop'

# --- Resolve the target exe -------------------------------------------------
if (-not $Target) {
    $Target = Join-Path $PSScriptRoot '..\..\dist\win-x64\stremio.exe'
}
try {
    $Target = (Resolve-Path -LiteralPath $Target).Path
} catch {
    throw "stremio.exe not found at '$Target'. Build the dist first or pass -Target."
}
Write-Host "Target: $Target" -ForegroundColor DarkGray

# --- Registry helpers ------------------------------------------------------
function Register-Protocol {
    param([string]$Scheme, [string]$Description, [int]$IconIndex)

    $base = "HKCU:\Software\Classes\$Scheme"
    New-Item -Path "$base\shell\open\command" -Force | Out-Null
    New-Item -Path "$base\DefaultIcon" -Force | Out-Null

    Set-ItemProperty -Path $base -Name '(default)'     -Value "URL:$Description"
    Set-ItemProperty -Path $base -Name 'URL Protocol'  -Value ''
    Set-ItemProperty -Path $base -Name 'FriendlyTypeName' -Value 'Stremio'
    Set-ItemProperty -Path "$base\DefaultIcon"        -Name '(default)' -Value "$Target,$IconIndex"
    Set-ItemProperty -Path "$base\shell"              -Name '(default)' -Value 'open'
    Set-ItemProperty -Path "$base\shell\open"         -Name 'FriendlyAppName' -Value 'Stremio'
    Set-ItemProperty -Path "$base\shell\open\command" -Name '(default)' -Value ('"{0}" "%1"' -f $Target)

    Write-Host "Registered ${Scheme}:// -> $Target" -ForegroundColor Green
}

function Unregister-Protocol {
    param([string]$Scheme)
    $base = "HKCU:\Software\Classes\$Scheme"
    if (Test-Path $base) {
        Remove-Item -Path $base -Recurse -Force
        Write-Host "Removed $base" -ForegroundColor Yellow
    } else {
        Write-Host "$base not present" -ForegroundColor DarkGray
    }
}

# --- URL helpers ---------------------------------------------------------
function ConvertTo-StremioUrl {
    param([string]$Url)
    $u = $Url.Trim()
    if ($u -match '^https?://') {
        return 'stremio://' + $u.Substring($matches[0].Length)
    }
    return $u
}

function Open-Urls {
    param([string[]]$Urls)
    $list = @($Urls | ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') } |
        ForEach-Object { ConvertTo-StremioUrl $_ })

    if (-not $list) { Write-Host 'No URLs to open.' -ForegroundColor Yellow; return }

    for ($i = 0; $i -lt $list.Count; $i++) {
        $url = $list[$i]
        Write-Host ("[{0}/{1}] {2}" -f ($i + 1), $list.Count, $url) -ForegroundColor Cyan
        & $Target $url
        if ($i -lt $list.Count - 1) { Start-Sleep -Seconds $Delay }
    }
}

# --- Dispatch ----------------------------------------------------------
$did = $false

if ($Unregister) {
    Unregister-Protocol 'stremio'
    if ($Magnet) { Unregister-Protocol 'magnet' }
    $did = $true
}

if ($Register) {
    Register-Protocol -Scheme 'stremio' -Description 'Stremio Protocol' -IconIndex 1
    if ($Magnet) { Register-Protocol -Scheme 'magnet' -Description 'Magnet Protocol' -IconIndex 0 }
    $did = $true
}

if ($File) {
    $path = (Resolve-Path -LiteralPath $File).Path
    Write-Host "Reading URLs from $path" -ForegroundColor DarkGray
    Open-Urls (Get-Content -LiteralPath $path)
    $did = $true
}

if ($Open) {
    Open-Urls $Open
    $did = $true
}

if (-not $did) {
    Get-Help $PSCommandPath -Detailed
}
