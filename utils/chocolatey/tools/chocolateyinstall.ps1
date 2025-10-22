$packageName = 'stremio-desktop-v5'
$toolsDir    = Split-Path $MyInvocation.MyCommand.Definition

$packageArgs = @{
  packageName    = $packageName
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}



if ([Environment]::Is64BitOperatingSystem) {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.20/Stremio.5.0.20-x64.exe'
    $packageArgs['checksum']     = '8ea913d802602b3aca1d6333e142a9a11cf070015f2d4ff7f5a4f1d543448879'
    $packageArgs['checksumType'] = 'sha256'
} else {
    $packageArgs['url']          = 'https://github.com/Zaarrg/stremio-desktop-v5/releases/download/5.0.0-beta.20/Stremio.5.0.20-x86.exe'
    $packageArgs['checksum']     = '659177650030b33c19e6cacad9f879fa25c3f91f2ecc8678a657998430beed7d'
    $packageArgs['checksumType'] = 'sha256'
}

Install-ChocolateyPackage @packageArgs
