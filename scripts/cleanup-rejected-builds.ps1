$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianDist = [IO.Path]::GetFullPath((Join-Path $guardianRoot 'dist'))
$guardianAccepted = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-verification.json') -Encoding utf8 | ConvertFrom-Json
if (-not $guardianAccepted.sourceFilesMatch -or -not $guardianAccepted.bundledChromium) { throw '保留所有包，尚未确认有效交付' }
foreach ($name in @('guardian-v2-win-x64-20261019-193621','guardian-v2-win-x64-20261019-193727')) {
 foreach ($suffix in @('', '.zip')) {
  $guardianTarget = [IO.Path]::GetFullPath((Join-Path $guardianDist ($name + $suffix)))
  if (-not $guardianTarget.StartsWith($guardianDist + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $guardianTarget -eq $guardianAccepted.directory) { throw '清理路径越界或指向有效包' }
  if (Test-Path -LiteralPath $guardianTarget) {
   if ((Test-Path -LiteralPath (Join-Path $guardianTarget 'runtime')) -or (Get-Item -LiteralPath $guardianTarget).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw '清理目标包含运行数据或为重解析点，保留' }
   Write-Output "清理本轮未交付的构建：$guardianTarget"
   Remove-Item -LiteralPath $guardianTarget -Recurse -Force
  }
 }
}
