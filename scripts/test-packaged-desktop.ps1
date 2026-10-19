param([string]$Executable)
$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Executable) { $Executable = Join-Path $guardianRoot 'desktop-dist\win-unpacked\DoudianGuardian.exe' }
if (-not (Test-Path -LiteralPath $Executable)) { throw '待验收程序不存在' }
$env:GUARDIAN_TEST_DESKTOP_EXE = $Executable
try {
 Push-Location -LiteralPath $guardianRoot
 & node.exe --test tests/desktop/window.test.mjs
 if ($LASTEXITCODE -ne 0) { throw '安装版窗口测试失败' }
} finally {
 Pop-Location
 Remove-Item Env:\GUARDIAN_TEST_DESKTOP_EXE -ErrorAction SilentlyContinue
}
