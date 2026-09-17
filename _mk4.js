const fs = require('fs');
let s = fs.readFileSync('_handles.ps1', 'utf8');

// 1) add privilege elevation + dup-failure counter to C#
const anchor = '  static IntPtr Dup(SH e) {';
const add = `  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr tok);
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
  static IntPtr Dup(SH e) {`;
if (!s.includes(anchor)) throw new Error('dup anchor missing');
s = s.replace(anchor, add);

// 2) count dup failures in QueryType/QueryName via Dup returning zero for openable pids: simpler - increment in Dup when OpenProcess ok but dup fails, and track open failures separately
s = s.replace(
  '    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);\r\n    CloseHandle(hp);\r\n    return ok ? dst : IntPtr.Zero;',
  '    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);\r\n    CloseHandle(hp);\r\n    if (!ok) System.Threading.Interlocked.Increment(ref DupFailures);\r\n    return ok ? dst : IntPtr.Zero;'
);
s = s.replace(
  '    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);\r\n    if (hp == IntPtr.Zero) return IntPtr.Zero;',
  '    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);\r\n    if (hp == IntPtr.Zero) { System.Threading.Interlocked.Increment(ref DupFailures); return IntPtr.Zero; }'
);

// 3) call EnableDebug at start of Find and report status + dup failures
s = s.replace(
  '    var res = new List<string>();\r\n    int len = 1 << 24;',
  '    var res = new List<string>();\r\n    res.Add("# " + EnableDebug());\r\n    int len = 1 << 24;'
);
s = s.replace(
  '    Marshal.FreeHGlobal(buf);\r\n    return res;',
  '    Marshal.FreeHGlobal(buf);\r\n    res.Add("# dup/open failures: " + DupFailures);\r\n    return res;'
);
fs.writeFileSync('_handles.ps1', s);
console.log('scanner v2 written');
