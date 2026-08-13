# DeepSeek Harness Desktop bootstrap (Windows).
# Checks for Node.js 18+. If it is missing or too old, downloads an official
# LTS zip into the user cache and then runs: npx deepseek-harness-desktop
#
# Does not replace a system Node install and does not need Administrator.

$ErrorActionPreference = 'Stop'
$MinMajor = 18
$FallbackVersion = 'v22.18.0'
$Mirror = if ($env:DSH_NODE_MIRROR) { $env:DSH_NODE_MIRROR } else { 'https://nodejs.org/dist' }

function Get-NodeMajor {
    try {
        $version = (& node -p "process.versions.node" 2>$null)
        if (-not $version) { return 0 }
        return [int]($version.Split('.')[0])
    } catch {
        return 0
    }
}

function Test-SystemNode {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if (-not $node -or -not $npx) { return $false }
    return (Get-NodeMajor) -ge $MinMajor
}

function Get-LatestLtsVersion {
    try {
        $releases = Invoke-RestMethod -Uri "$Mirror/index.json"
        foreach ($release in $releases) {
            if ($release.lts) { return $release.version }
        }
    } catch {
        return $FallbackVersion
    }
    return $FallbackVersion
}

function Install-LocalNode {
    $version = Get-LatestLtsVersion
    if ($version -notmatch '^v\d+') { $version = $FallbackVersion }
    $target = 'win-x64'
    $root = Join-Path $env:LOCALAPPDATA 'deepseek-harness-desktop\runtime-node'
    $prefix = Join-Path $root "$version-$target"
    $nodeExe = Join-Path $prefix 'node.exe'
    if (Test-Path $nodeExe) {
        Write-Host "Using cached Node.js $version ($prefix)."
        return $prefix
    }

    $archive = "node-$version-$target.zip"
    $url = "$Mirror/$version/$archive"
    $staging = Join-Path $root ('.node-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $zip = Join-Path $staging $archive
    Write-Host "Node.js 18+ not found. Downloading official $version for $target..."
    Invoke-WebRequest -Uri $url -OutFile $zip

    Expand-Archive -Path $zip -DestinationPath $staging -Force
    $extracted = Join-Path $staging "node-$version-$target"
    if (-not (Test-Path (Join-Path $extracted 'node.exe'))) {
        throw "downloaded Node.js archive is missing node.exe"
    }
    if (Test-Path $prefix) { Remove-Item -Recurse -Force $prefix }
    New-Item -ItemType Directory -Force -Path (Split-Path $prefix) | Out-Null
    Move-Item $extracted $prefix
    Remove-Item -Recurse -Force $staging
    Write-Host "Installed local Node.js $(& $nodeExe -v) (does not replace system Node)."
    return $prefix
}

if ($args -contains '--check') {
    if (Test-SystemNode) {
        Write-Host "Node.js $(& node -v) at $((Get-Command node).Source) — OK (>= $MinMajor)"
        exit 0
    }
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Host "Node.js $(& node -v) is too old. Need $MinMajor+."
    } else {
        Write-Host "Node.js is not installed. Need $MinMajor+."
    }
    exit 2
}

if (-not (Test-SystemNode)) {
    $binDir = Install-LocalNode
    $env:Path = "$binDir;$env:Path"
    if (-not (Test-SystemNode)) {
        throw "downloaded Node.js still does not satisfy $MinMajor+"
    }
} else {
    Write-Host "Using Node.js $(& node -v)."
}

& npx --yes deepseek-harness-desktop @args
exit $LASTEXITCODE
