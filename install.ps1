<#
.SYNOPSIS
    Cortex installer for Windows.

.EXAMPLE
    irm https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.ps1 | iex

.EXAMPLE
    curl.exe -fsSL https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.ps1 | powershell -NoProfile -ExecutionPolicy Bypass -Command -

.NOTES
    CORTEX_HOME          Install directory           (default: %USERPROFILE%\.cortex)
    CORTEX_STORAGE_DIR   Local storage partition dir (default: %USERPROFILE%\.cortex\storage)
    CORTEX_VERSION       Release tag to install      (default: latest)
    CORTEX_REPO          GitHub owner/repo           (default: Ashish-Karmakar-coding/cortex)
    CORTEX_DOWNLOAD_URL  Override archive URL        (mirrors/testing)
#>
[CmdletBinding()]
param(
    [string]$Version = $env:CORTEX_VERSION,
    [string]$StorageDir = $env:CORTEX_STORAGE_DIR
)

$ErrorActionPreference = 'Stop'

$Repo = if ($env:CORTEX_REPO) { $env:CORTEX_REPO } else { 'Ashish-Karmakar-coding/cortex' }
$CortexHome = if ($env:CORTEX_HOME) { $env:CORTEX_HOME } else { Join-Path $HOME '.cortex' }
$ResolvedStorageDir = if ($StorageDir) { $StorageDir } else { Join-Path $CortexHome 'storage' }
$BinDir = Join-Path $CortexHome 'bin'

function Write-Cyan([string]$Message) { Write-Host $Message -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host $Message -ForegroundColor Green }

Write-Cyan 'Cortex installer'

# --- Requirements -----------------------------------------------------------

$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    Write-Host 'error: Node.js 22.13 or newer is required, but node was not found.' -ForegroundColor Red
    Write-Host 'Install it with:  winget install OpenJS.NodeJS.LTS'
    Write-Host 'or download it from https://nodejs.org and re-run this script.'
    exit 1
}

$NodeVersion = (& node -p 'process.versions.node').Trim()
$NodeParts = $NodeVersion.Split('.')
$NodeOk = ([int]$NodeParts[0] -gt 22) -or ([int]$NodeParts[0] -eq 22 -and [int]$NodeParts[1] -ge 13)
if (-not $NodeOk) {
    Write-Host "error: Node.js $NodeVersion found, but Cortex needs 22.13+." -ForegroundColor Red
    Write-Host 'Upgrade Node.js from https://nodejs.org and try again.'
    exit 1
}

# PowerShell 5.1 defaults to older TLS on some machines.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Ignore on PowerShell 7+, where this is already configured.
}

# --- Download ---------------------------------------------------------------

if ($env:CORTEX_DOWNLOAD_URL) {
    $Url = $env:CORTEX_DOWNLOAD_URL
} elseif ($Version -and $Version -ne 'latest') {
    $Tag = $Version.TrimStart('v')
    $Url = "https://github.com/$Repo/releases/download/v$Tag/cortex.zip"
} else {
    $Url = "https://github.com/$Repo/releases/latest/download/cortex.zip"
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cortex-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
$ZipPath = Join-Path $TempDir 'cortex.zip'

try {
    Write-Cyan "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing

    New-Item -ItemType Directory -Path $CortexHome -Force | Out-Null

    # Extract into a clean temp folder first. Expand-Archive -Force uses a
    # .NET overload that does not exist on Windows PowerShell 5.1 when the
    # destination already contains files (i.e. during `cortex upgrade`).
    $ExtractDir = Join-Path $TempDir 'extract'
    New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force
    Copy-Item -Path (Join-Path $ExtractDir '*') -Destination $CortexHome -Recurse -Force
} catch {
    Write-Host 'error: Could not download or extract Cortex.' -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
    Write-Host "Check https://github.com/$Repo/releases for an available release."
    exit 1
} finally {
    Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}

$Bundle = Join-Path $BinDir 'cortex.js'
if (-not (Test-Path $Bundle)) {
    Write-Host 'error: The archive did not contain bin\cortex.js.' -ForegroundColor Red
    exit 1
}

# --- Launcher ---------------------------------------------------------------

$Launcher = Join-Path $BinDir 'cortex.cmd'
$LauncherContent = @"
@echo off
node --disable-warning=ExperimentalWarning "%~dp0cortex.js" %*
"@
Set-Content -Path $Launcher -Value $LauncherContent -Encoding Ascii

# --- Local Storage Partition ------------------------------------------------

try {
    $env:CORTEX_HOME = $CortexHome
    & node --disable-warning=ExperimentalWarning $Bundle init-storage --storage-dir $ResolvedStorageDir | Out-Null
} catch {
    Write-Host "warning: Could not pre-initialize storage partition ($($_.Exception.Message)). It will initialize on first launch." -ForegroundColor Yellow
}

# --- PATH -------------------------------------------------------------------

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $UserPath) { $UserPath = '' }
$PathParts = $UserPath.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)
$HasBinDir = $false
foreach ($Part in $PathParts) {
    if ($Part.TrimEnd('\') -ieq $BinDir.TrimEnd('\')) { $HasBinDir = $true; break }
}

if (-not $env:CORTEX_NO_MODIFY_PATH) {
    if (-not $HasBinDir) {
        $NewUserPath = if ($UserPath.Trim()) { "$BinDir;$UserPath" } else { $BinDir }
        [Environment]::SetEnvironmentVariable('Path', $NewUserPath, 'User')
    }

    if (-not ($env:Path.Split(';') | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') })) {
        $env:Path = "$BinDir;$env:Path"
    }
}

# --- Done -------------------------------------------------------------------

$InstalledVersion = 'unknown'
try { $InstalledVersion = (& node $Bundle --version).Trim() } catch { }

Write-Ok "Cortex $InstalledVersion installed."
Write-Host "  Binary  : $Launcher"
Write-Host "  Config  : $CortexHome"
Write-Host "  Storage : $ResolvedStorageDir"
Write-Host ''
Write-Host 'Run: cortex'
if (-not $HasBinDir -and -not $env:CORTEX_NO_MODIFY_PATH) {
    Write-Host 'Open a new terminal first so the updated PATH is picked up.'
}
