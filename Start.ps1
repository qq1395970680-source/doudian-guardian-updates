param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$guardianNode = Join-Path $PSScriptRoot 'engine\node.exe'
if (-not (Test-Path -LiteralPath $guardianNode)) { $guardianNode = (Get-Command node.exe -ErrorAction Stop).Source }
& $guardianNode (Join-Path $PSScriptRoot 'scripts\start-local.mjs')
if ($LASTEXITCODE -ne 0) { throw '后台未能连接，未重复启动。请查看程序运行记录。' }
if (-not $NoOpen) { Start-Process -FilePath 'http://127.0.0.1:19417' }
