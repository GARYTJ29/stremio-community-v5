$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.22/Stremio.5.0.22-x64.exe'
    $packageArgs['checksum']     = 'b07653307e87681269c4e68628cfc71f0075c0c4d39fa1a292c6870f936b4dc4'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.22/Stremio.5.0.22-x86.exe'
    $packageArgs['checksum']     = 'a2c68eb218479751c9aed532b2456de1b32df3bd2ed9c939a0ca044ffa57d128'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
