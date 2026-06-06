# Build rfid-bridge.exe for Weighbridge Manager
# Requires: .NET Framework 4.8 + MSBuild (Visual Studio Build Tools)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LibDir = Join-Path $Root "lib"
$LocalDll = Join-Path $LibDir "ReaderAPI.dll"

if (Test-Path $LocalDll) {
    Write-Host "Using existing ReaderAPI.dll from rfid-bridge/lib."
} else {
    $SdkDll = "D:\rfid-project-krishna\SDK Kit for ETS-IR 04\C#\Libs\ReaderAPI.dll"
    if (-not (Test-Path $SdkDll)) {
        $SdkDll = "D:\rfid-project-krishna\SDK Kit for ETS-IR 04\C#\Example\SampleCode\ReaderAPI.dll"
    }

    if (-not (Test-Path $SdkDll)) {
        $force = $env:FORCE_RFID_BRIDGE_BUILD
        if ($force -and $force.ToLower() -eq "true") {
            throw "ReaderAPI.dll not found. Copy it to rfid-bridge\lib\ReaderAPI.dll (or set FORCE_RFID_BRIDGE_BUILD=true)."
        }

        Write-Warning "ReaderAPI.dll not found. Skipping rfid-bridge build."
        exit 0
    }

    New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
    Copy-Item -Force $SdkDll (Join-Path $LibDir "ReaderAPI.dll")
}

$msbuild = @(
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $msbuild) {
    throw "MSBuild not found. Install Visual Studio Build Tools with .NET desktop development."
}

& $msbuild (Join-Path $Root "rfid-bridge.csproj") /p:Configuration=Release /v:minimal
Write-Host "Built: $(Join-Path $Root 'bin\rfid-bridge.exe')"
