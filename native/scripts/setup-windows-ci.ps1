param(
  [ValidateSet("x64", "arm64")]
  [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$PnpmVersion = if ($env:PNPM_VERSION) { $env:PNPM_VERSION } else { "10.33.4" }
$RustTarget = if ($Arch -eq "arm64") { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }

function Test-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-CargoPath {
  $CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if ((Test-Path $CargoBin) -and -not ($env:Path.Split(";") -contains $CargoBin)) {
    $env:Path = "$CargoBin;$env:Path"
  }
}

if (-not (Test-Command "node")) {
  throw "Node.js is required on the Windows sandbox validation runner"
}

if (-not (Test-Command "pnpm")) {
  corepack enable
  if (-not (Test-Command "pnpm")) {
    npm install -g "pnpm@$PnpmVersion"
  }
}

Add-CargoPath
if (-not (Test-Command "cargo")) {
  if (-not (Test-Command "rustup")) {
    $RustupInit = Join-Path $env:TEMP "rustup-init.exe"
    Invoke-WebRequest "https://win.rustup.rs/x86_64" -OutFile $RustupInit
    & $RustupInit -y --default-toolchain stable --profile minimal --target $RustTarget
    if ($LASTEXITCODE -ne 0) {
      throw "rustup-init failed with exit code $LASTEXITCODE"
    }
    Add-CargoPath
  }
}

if (Test-Command "rustup") {
  rustup target add $RustTarget
}

if (-not (Test-Command "cargo")) {
  throw "Cargo is required on the Windows sandbox validation runner"
}

if (-not (Test-Command "link.exe")) {
  Write-Warning "MSVC link.exe was not found in PATH. Rust MSVC builds may fail unless the runner has Visual Studio Build Tools configured."
}

node -v
pnpm --version
cargo --version
