using System;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

// Small Windows-only maintenance helper. It accepts one exact owned service
// identity on stdin, never a name-based kill or an arbitrary shell command.
public class OwnedProcesses {
 public class Expected { public int pid; public string exe; public double startedAt; public string sourceRoot; public string runtime; }
 public class Entry { public int pid; public int parentPid; public string exe; public string created; public string commandLine; }
 public class Request { public string mode; public Expected expected; public Entry[] identity; }
 static JavaScriptSerializer json=new JavaScriptSerializer();
 [DllImport("shell32.dll",SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 static string[] Args(string cmd){int n;var ptr=CommandLineToArgvW(cmd,out n);if(ptr==IntPtr.Zero)throw new Exception("进程命令行无法解析");try{return Enumerable.Range(0,n).Select(i=>Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr,i*IntPtr.Size))).ToArray();}finally{LocalFree(ptr);}}
 static string PathOf(string p){return Path.GetFullPath(p).TrimEnd('\\');}
 static bool SamePath(string a,string b){return String.Equals(PathOf(a),PathOf(b),StringComparison.OrdinalIgnoreCase);}
 static double Epoch(Entry e){return (ManagementDateTimeConverter.ToDateTime(e.created).ToUniversalTime()-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;}
 // ParentProcessId may refer to a dead parent whose PID Windows has since
 // reused. A process older than this parent instance is not its descendant.
 static bool IsChildOf(Entry parent,Entry child){return child.parentPid==parent.pid&&Epoch(child)>=Epoch(parent);}
 static List<Entry> Query(string filter){
  using(var search=new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,ExecutablePath,CreationDate,CommandLine FROM Win32_Process WHERE "+filter))
   return search.Get().Cast<ManagementObject>().Select(p=>new Entry{pid=Convert.ToInt32(p["ProcessId"]),parentPid=Convert.ToInt32(p["ParentProcessId"]),exe=p["ExecutablePath"] as string,created=p["CreationDate"] as string,commandLine=p["CommandLine"] as string}).ToList();
 }
 static List<Entry> Tree(int pid){
  var result=Query("ProcessId="+pid);if(result.Count!=1)throw new Exception("目标进程不存在或不唯一");
  for(int i=0;i<result.Count;i++){if(result.Count>1000)throw new Exception("进程树超过维护上限");foreach(var p in Query("ParentProcessId="+result[i].pid))if(IsChildOf(result[i],p)&&!result.Any(v=>v.pid==p.pid))result.Add(p);}
  return result;
 }
 static void Validate(Expected expected,List<Entry> tree){
  var root=tree[0];if(root.pid!=expected.pid||String.IsNullOrEmpty(root.exe)||String.IsNullOrEmpty(root.commandLine)||!SamePath(root.exe,expected.exe)||Math.Abs(Epoch(root)-expected.startedAt)>60000)throw new Exception("后台路径或启动时间不匹配");
  var args=Args(root.commandLine);if(args.Length!=2&&args.Length!=4||!SamePath(args[0],expected.exe)||args[1]!="src/server.mjs"||args.Length==4&&(args[2]!="--shop"||!Regex.IsMatch(args[3],@"^\d{3,25}$")))throw new Exception("后台启动参数不匹配");
  var browserRoot=PathOf(Path.Combine(expected.sourceRoot,"browsers"))+"\\";var profileRoot=PathOf(Path.Combine(expected.runtime,"profiles"))+"\\";
  foreach(var child in tree.Skip(1)){
   // Windows can allocate an owned hidden console host even with redirected
   // stdio. It is permitted only as a newly created direct child of this node.
   if(child.parentPid==root.pid&&!String.IsNullOrEmpty(child.exe)&&SamePath(child.exe,Path.Combine(Environment.SystemDirectory,"conhost.exe"))&&Epoch(child)>=Epoch(root))continue;
   if(String.IsNullOrEmpty(child.exe)||String.IsNullOrEmpty(child.commandLine)||!PathOf(child.exe).StartsWith(browserRoot,StringComparison.OrdinalIgnoreCase)||!Regex.IsMatch(Path.GetFileName(child.exe),@"^(chrome|chrome_crashpad_handler|crashpad_handler)\.exe$",RegexOptions.IgnoreCase)||Epoch(child)<Epoch(root)||!tree.Any(p=>p.pid==child.parentPid))throw new Exception("包含无法证明属于专用浏览器的子进程："+Path.GetFileName(child.exe)+" / "+child.pid+" / "+(Epoch(child)-Epoch(root)));
   if(child.parentPid==root.pid){
    var profiles=Args(child.commandLine).Where(a=>a.StartsWith("--user-data-dir=",StringComparison.Ordinal)).Select(a=>PathOf(a.Substring(16))).ToArray();
    if(profiles.Length!=1||!profiles[0].StartsWith(profileRoot,StringComparison.OrdinalIgnoreCase)||!Regex.IsMatch(profiles[0].Substring(profileRoot.Length),@"^(shop-\d+|signin-[a-zA-Z0-9-]+)$"))throw new Exception("浏览器资料目录不属于本程序");
   }
  }
 }
 static bool Same(Entry a,Entry b){return a.pid==b.pid&&a.parentPid==b.parentPid&&SamePath(a.exe,b.exe)&&a.created==b.created&&a.commandLine==b.commandLine;}
 public static int Main(){
  try{
   Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
   var request=json.Deserialize<Request>(Console.In.ReadToEnd());if(request==null||request.expected==null||request.expected.pid<=0)throw new Exception("维护参数无效");
   if(request.mode!="inspect"&&request.mode!="terminate")throw new Exception("维护模式无效");
   var tree=Tree(request.expected.pid);Validate(request.expected,tree);
   if(request.mode=="inspect"){Console.Write(json.Serialize(tree));return 0;}
   if(request.identity==null||request.identity.Length==0||!Same(tree[0],request.identity[0])||request.identity.Any(e=>tree.Any(p=>p.pid==e.pid&&!Same(p,e))))throw new Exception("进程身份发生变化，未执行关闭");
   // Chromium may retire or create utility children between inspection and
   // termination. The fresh tree is revalidated in full against the unchanged
   // root identity and dedicated profile; no unrecognised child is accepted.
   var handles=new List<Process>();
   try{
    // Open handles and recheck creation times before any termination. Holding
    // the handles prevents an exit/reused PID from targeting a new process.
    foreach(var entry in tree){var p=Process.GetProcessById(entry.pid);var handle=p.Handle;if(Math.Abs((p.StartTime.ToUniversalTime()-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds-Epoch(entry))>2)throw new Exception("进程已替换，取消维护");handles.Add(p);}
    var immediate=Tree(request.expected.pid);Validate(request.expected,immediate);if(immediate.Count!=tree.Count||!immediate.All(p=>tree.Any(e=>Same(p,e))))throw new Exception("关闭前进程集合变化，取消维护");
    foreach(var p in handles){if(!p.HasExited)p.Kill();if(!p.WaitForExit(5000))throw new Exception("目标进程退出未确认");}
    foreach(var entry in tree){if(Query("ProcessId="+entry.pid).Any(p=>p.created==entry.created))throw new Exception("目标进程仍在运行");
     if(Query("ParentProcessId="+entry.pid).Any(p=>IsChildOf(entry,p)&&!tree.Any(e=>Same(p,e))))throw new Exception("发现未记录子进程，未确认完整关闭");}
    Console.Write("{\"closed\":true}");return 0;
   }finally{foreach(var p in handles)p.Dispose();}
  }catch(Exception error){Console.Error.Write(error.Message);return 1;}
 }
}
