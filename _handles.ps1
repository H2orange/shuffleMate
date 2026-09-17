$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class HF {
  [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int retlen);
  [DllImport("ntdll.dll")] public static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int retlen);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool DuplicateHandle(IntPtr hSrcProc, IntPtr hSrc, IntPtr hDstProc, out IntPtr hDst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [StructLayout(LayoutKind.Sequential)]
  public struct SH { public uint Pid; public byte Type; public byte Flags; public ushort Handle; public IntPtr Object; public uint Access; }
  public static List<string> Find(string needle) {
    var res = new List<string>();
    res.Add("# " + EnableDebug());
    int len = 1 << 24;
    IntPtr buf = Marshal.AllocHGlobal(len);
    int ret;
    int st = NtQuerySystemInformation(16, buf, len, out ret);
    if (st != 0) { res.Add("sysinfo failed 0x" + st.ToString("x")); return res; }
    long count = Marshal.ReadInt64(buf);
    IntPtr p = buf + 8;
    var typeNames = new Dictionary<byte, string>();
    int me = Process.GetCurrentProcess().Id;
    for (long i = 0; i < count; i++) {
      SH e = Marshal.PtrToStructure<SH>(p);
      p += Marshal.SizeOf<SH>();
      if (e.Pid == me || e.Pid == 0) continue;
      string tname;
      if (!typeNames.TryGetValue(e.Type, out tname)) { tname = QueryType(e); typeNames[e.Type] = tname; }
      if (tname != "File" && tname != "Section") continue;
      string name = QueryName(e);
      if (name != null && name.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        string pname = "?";
        try { pname = Process.GetProcessById((int)e.Pid).ProcessName; } catch { }
        res.Add(e.Pid + " | " + pname + " | handle 0x" + e.Handle.ToString("x") + " | " + name);
      }
    }
    Marshal.FreeHGlobal(buf);
    res.Add("# dup/open failures: " + DupFailures);
    lock (FailedPids) {
      var names = new System.Collections.Generic.List<string>();
      foreach (var pid in FailedPids) { string n = "?"; try { n = Process.GetProcessById(pid).ProcessName; } catch { n = "gone"; } names.Add(pid + ":" + n); }
      res.Add("# failed pids: " + string.Join(", ", names));
    }
    return res;
  }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr tok, bool disableAll, ref TOKEN_PRIVILEGES tp, uint len, IntPtr prev, IntPtr retlen);
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_PRIVILEGES { public uint Count; public long Luid; public uint Attr; }
  public static string EnableDebug() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0028, out tok)) return "OpenProcessToken failed";
    long luid;
    if (!LookupPrivilegeValue(null, "SeDebugPrivilege", out luid)) return "Lookup failed";
    var tp = new TOKEN_PRIVILEGES(); tp.Count = 1; tp.Luid = luid; tp.Attr = 2;
    bool ok = AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    return ok ? "SeDebugPrivilege enabled" : "Adjust failed " + Marshal.GetLastWin32Error();
  }
  public static int DupFailures;
  public static System.Collections.Generic.List<int> FailedPids = new System.Collections.Generic.List<int>();
  static IntPtr Dup(SH e) {
    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);
    if (hp == IntPtr.Zero) { System.Threading.Interlocked.Increment(ref DupFailures); lock (FailedPids) { if (!FailedPids.Contains((int)e.Pid)) FailedPids.Add((int)e.Pid); } return IntPtr.Zero; }
    IntPtr dst;
    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);
    CloseHandle(hp);
    if (!ok) System.Threading.Interlocked.Increment(ref DupFailures);
    return ok ? dst : IntPtr.Zero;
  }
  static string QueryType(SH e) {
    IntPtr h = Dup(e);
    if (h == IntPtr.Zero) return "";
    IntPtr b = Marshal.AllocHGlobal(0x1000); int ret;
    string s = "";
    if (NtQueryObject(h, 2, b, 0x1000, out ret) == 0) {
      int ulen = Marshal.ReadInt16(b);
      IntPtr np = Marshal.ReadIntPtr(b + 8);
      if (np != IntPtr.Zero && ulen > 0) s = Marshal.PtrToStringUni(np, ulen / 2);
    }
    Marshal.FreeHGlobal(b);
    CloseHandle(h);
    return s;
  }
  static string QueryName(SH e) {
    IntPtr h = Dup(e);
    if (h == IntPtr.Zero) return null;
    IntPtr b = Marshal.AllocHGlobal(0x2000); int ret;
    string s = null;
    if (NtQueryObject(h, 1, b, 0x2000, out ret) == 0) {
      int ulen = Marshal.ReadInt16(b);
      IntPtr np = Marshal.ReadIntPtr(b + 8);
      if (np != IntPtr.Zero && ulen > 0) s = Marshal.PtrToStringUni(np, ulen / 2);
    }
    Marshal.FreeHGlobal(b);
    CloseHandle(h);
    return s;
  }
}
'@
$r = [HF]::Find('app.asar')
if ($r.Count -eq 0) { 'NO FILE HANDLE MATCH' } else { $r }