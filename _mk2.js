const fs = require('fs');
const AT = String.fromCharCode(39) + '@';
const SQAT = String.fromCharCode(39);
const cs = `using System;
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
      if (tname != "File") continue;
      string name = QueryName(e);
      if (name != null && name.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        string pname = "?";
        try { pname = Process.GetProcessById((int)e.Pid).ProcessName; } catch { }
        res.Add(e.Pid + " | " + pname + " | handle 0x" + e.Handle.ToString("x") + " | " + name);
      }
    }
    Marshal.FreeHGlobal(buf);
    return res;
  }
  static IntPtr Dup(SH e) {
    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);
    if (hp == IntPtr.Zero) return IntPtr.Zero;
    IntPtr dst;
    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);
    CloseHandle(hp);
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
}`;
const ps1 = [
"$ErrorActionPreference = 'Stop'",
'Add-Type -TypeDefinition @' + SQAT,
cs,
AT,
"$r = [HF]::Find('app.asar')",
"if ($r.Count -eq 0) { 'NO FILE HANDLE MATCH' } else { $r }"
].join('\r\n');
fs.writeFileSync('_handles.ps1', ps1);
console.log('handles ps1 written');
