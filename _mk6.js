const fs = require('fs');
let s = fs.readFileSync('_handles.ps1', 'utf8');
const a = '  public static int DupFailures;';
const b = `  public static int DupFailures;
  public static System.Collections.Generic.List<int> FailedPids = new System.Collections.Generic.List<int>();`;
if (!s.includes(a)) throw new Error('anchor1 missing');
s = s.replace(a, b);
const a2 = '    if (hp == IntPtr.Zero) { System.Threading.Interlocked.Increment(ref DupFailures); return IntPtr.Zero; }';
const b2 = '    if (hp == IntPtr.Zero) { System.Threading.Interlocked.Increment(ref DupFailures); lock (FailedPids) { if (!FailedPids.Contains((int)e.Pid)) FailedPids.Add((int)e.Pid); } return IntPtr.Zero; }';
if (!s.includes(a2)) throw new Error('anchor2 missing');
s = s.replace(a2, b2);
const a3 = '    res.Add("# dup/open failures: " + DupFailures);';
const b3 = `    res.Add("# dup/open failures: " + DupFailures);
    lock (FailedPids) {
      var names = new System.Collections.Generic.List<string>();
      foreach (var pid in FailedPids) { string n = "?"; try { n = Process.GetProcessById(pid).ProcessName; } catch { n = "gone"; } names.Add(pid + ":" + n); }
      res.Add("# failed pids: " + string.Join(", ", names));
    }`;
if (!s.includes(a3)) throw new Error('anchor3 missing');
s = s.replace(a3, b3);
fs.writeFileSync('_handles.ps1', s);
console.log('scanner v4 written');
