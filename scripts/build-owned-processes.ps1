$ErrorActionPreference = 'Stop'
$guardianRoot = Split-Path -Parent $PSScriptRoot
$guardianCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$guardianSource = Join-Path $guardianRoot 'desktop\owned-processes.cs'
$guardianOutput = Join-Path $guardianRoot 'desktop\assets\GuardianOwnedProcesses.exe'
& $guardianCompiler /nologo /target:exe /optimize+ /reference:System.Management.dll /reference:System.Web.Extensions.dll "/out:$guardianOutput" $guardianSource
if ($LASTEXITCODE -ne 0) { throw 'Owned process helper compilation failed' }
Get-Item -LiteralPath $guardianOutput | Select-Object Name,Length
