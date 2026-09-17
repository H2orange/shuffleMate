const fs = require('fs');
let s = fs.readFileSync('_handles.ps1', 'utf8');
const reps = [
  ['    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);\n    CloseHandle(hp);\n    return ok ? dst : IntPtr.Zero;',
   '    bool ok = DuplicateHandle(hp, (IntPtr)e.Handle, GetCurrentProcess(), out dst, 0, false, 2);\n    CloseHandle(hp);\n    if (!ok) System.Threading.Interlocked.Increment(ref DupFailures);\n    return ok ? dst : IntPtr.Zero;'],
  ['    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);\n    if (hp == IntPtr.Zero) return IntPtr.Zero;',
   '    IntPtr hp = OpenProcess(0x0040, false, (int)e.Pid);\n    if (hp == IntPtr.Zero) { System.Threading.Interlocked.Increment(ref DupFailures); return IntPtr.Zero; }'],
  ['    var res = new List<string>();\n    int len = 1 << 24;',
   '    var res = new List<string>();\n    res.Add("# " + EnableDebug());\n    int len = 1 << 24;'],
  ['    Marshal.FreeHGlobal(buf);\n    return res;',
   '    Marshal.FreeHGlobal(buf);\n    res.Add("# dup/open failures: " + DupFailures);\n    return res;']
];
for (const [a, b] of reps) {
  if (!s.includes(a)) throw new Error('target missing: ' + a.slice(0, 60));
  s = s.replace(a, b);
}
fs.writeFileSync('_handles.ps1', s);
console.log('scanner v3 written');
