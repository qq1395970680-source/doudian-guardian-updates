$ErrorActionPreference = 'Stop'
$guardianRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$guardianPackage = Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\package-result.json') -Encoding utf8 | ConvertFrom-Json
$guardianManifest = Get-Content -LiteralPath (Join-Path $guardianPackage.directory 'manifest-sha256.json') -Encoding utf8 | ConvertFrom-Json
$guardianZip = [IO.Compression.ZipFile]::OpenRead($guardianPackage.zip)
try {
 $guardianPrefix = [IO.Path]::GetFileName($guardianPackage.directory) + '/'
 foreach ($entry in $guardianManifest) {
  $guardianName = $guardianPrefix + $entry.path.Replace('\','/')
  $guardianFile = $guardianZip.GetEntry($guardianName)
  if (-not $guardianFile) { throw "安装包缺少 $guardianName" }
  $guardianStream = $guardianFile.Open()
  try { $guardianHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($guardianStream)) } finally { $guardianStream.Dispose() }
  if ($guardianHash -ne $entry.sha256) { throw "安装包哈希不一致 $guardianName" }
 }
 [ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');zip=$guardianPackage.zip;matchedFiles=$guardianManifest.Count;allHashesMatch=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\archive-verification.json') -Encoding utf8
 Get-Content -LiteralPath (Join-Path $guardianRoot 'artifacts\archive-verification.json') -Encoding utf8
} finally { $guardianZip.Dispose() }
