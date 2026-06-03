# Build rfid-bridge.exe for Weighbridge Manager
# Requires: .NET Framework 4.8 + MSBuild (Visual Studio Build Tools)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LibDir = Join-Path $Root "lib"
$SdkDll = "D:\rfid-project-krishna\SDK Kit for ETS-IR 04\C#\Libs\ReaderAPI.dll"

if (-not (Test-Path $SdkDll)) {
    $SdkDll = "D:\rfid-project-krishna\SDK Kit for ETS-IR 04\C#\Example\SampleCode\ReaderAPI.dll"
}

if (-not (Test-Path $SdkDll)) {
    throw "ReaderAPI.dll not found. Copy it to rfid-bridge\lib\ReaderAPI.dll"
}

New-Item -ItemType Directory -Force -Path $LibDir | Out-Null
Copy-Item -Force $SdkDll (Join-Path $LibDir "ReaderAPI.dll")

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
