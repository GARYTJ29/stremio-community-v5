$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.21/Stremio.5.0.21-x64.exe'
    $packageArgs['checksum']     = '6b2597e3179355fb59b62df762d65dbe3e493f96471fa3cf17e1620fadd0a1d7'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.21/Stremio.5.0.21-x86.exe'
    $packageArgs['checksum']     = 'f2dfad202ae03b26a1d584d9a4e8747be6e0b078e6c6c5773d57632bdfe3aee0'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
