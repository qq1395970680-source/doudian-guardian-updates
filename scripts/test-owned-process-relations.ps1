$ErrorActionPreference = 'Stop'
$guardianTemp = Join-Path ([IO.Path]::GetTempPath()) ('guardian-owner-relation-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $guardianTemp | Out-Null
try {
 $guardianHarness = @'
using System;
using System.Reflection;
using System.Collections.Generic;
using System.Management;
public class OwnershipRelationsTests {
 static string At(int seconds) { return ManagementDateTimeConverter.ToDmtfDateTime(new DateTime(2026,10,24,10,0,0,DateTimeKind.Utc).AddSeconds(seconds)); }
 static void Check(bool value,string name) { if(!value)throw new Exception(name); }
 public static int Main() {
  var method=typeof(OwnedProcesses).GetMethod("IsChildOf",BindingFlags.NonPublic|BindingFlags.Static);
  var parent=new OwnedProcesses.Entry{pid=400,parentPid=1,created=At(60)};
  Check(!(bool)method.Invoke(null,new object[]{parent,new OwnedProcesses.Entry{pid=500,parentPid=400,created=At(0)}}),"reused parent PID included an older business process");
  Check((bool)method.Invoke(null,new object[]{parent,new OwnedProcesses.Entry{pid=501,parentPid=400,created=At(61)}}),"new child was missed");
  Check(!(bool)method.Invoke(null,new object[]{parent,new OwnedProcesses.Entry{pid=502,parentPid=401,created=At(61)}}),"different parent included");
  var validate=typeof(OwnedProcesses).GetMethod("Validate",BindingFlags.NonPublic|BindingFlags.Static);
  var expected=new OwnedProcesses.Expected{pid=400,exe=@"C:\guardian\engine\node.exe",startedAt=(new DateTime(2026,10,24,10,1,0,DateTimeKind.Utc)-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds,sourceRoot=@"C:\guardian",runtime=@"C:\guardian-runtime"};
  parent.exe=expected.exe;parent.commandLine="\""+expected.exe+"\" src/server.mjs";
  bool rejected=false;
  try { validate.Invoke(null,new object[]{expected,new List<OwnedProcesses.Entry>{parent,new OwnedProcesses.Entry{pid=503,parentPid=400,created=At(61),exe=@"C:\other\business.exe",commandLine="business.exe"}}}); }
  catch(TargetInvocationException error) { rejected=error.InnerException.Message.Contains("无法证明属于专用浏览器"); }
  Check(rejected,"new unknown child no longer blocks termination");
  Console.Write("{\"passed\":4,\"olderParentPidLinksIgnored\":true,\"newUnknownChildStillRejected\":true}");return 0;
 }
}
'@
 $guardianTestSource = Join-Path $guardianTemp 'OwnershipRelationsTests.cs'
 Set-Content -LiteralPath $guardianTestSource -Value $guardianHarness -Encoding UTF8
 $guardianCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 $guardianSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\desktop\owned-processes.cs'))
 $guardianTestExe = Join-Path $guardianTemp 'OwnershipRelationsTests.exe'
 & $guardianCompiler /nologo /target:exe /main:OwnershipRelationsTests /reference:System.Management.dll /reference:System.Web.Extensions.dll "/out:$guardianTestExe" $guardianSource $guardianTestSource
 if ($LASTEXITCODE -ne 0) { throw 'Ownership relation harness compilation failed' }
 & $guardianTestExe
 if ($LASTEXITCODE -ne 0) { throw 'Ownership relation regression failed' }
} finally {
 $guardianResolved = [IO.Path]::GetFullPath($guardianTemp)
 if ([IO.Path]::GetDirectoryName($guardianResolved) -ne [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar) -or [IO.Path]::GetFileName($guardianResolved) -notmatch '^guardian-owner-relation-test-[a-f0-9]{32}$') { throw 'Unexpected test cleanup path; preserve it' }
 Remove-Item -LiteralPath $guardianResolved -Recurse -Force
}
