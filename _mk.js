const fs = require('fs');
const AT = String.fromCharCode(39) + '@';
const cs = [
'using System;',
'using System.Collections.Generic;',
'using System.Runtime.InteropServices;',
'public static class RmLock {',
'  [StructLayout(LayoutKind.Sequential)]',
'  public struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }',
'  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
'  public struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName; public int ApplicationType; public uint AppStatus; public uint TSSessionId; public bool bRestartable; }',
'  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);',
'  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);',
'  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);',
'  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint pSessionHandle);',
'  public static List<string> Locking(string[] files) {',
'    var res = new List<string>();',
'    uint session; string key = Guid.NewGuid().ToString();',
'    if (RmStartSession(out session, 0, key) != 0) return res;',
'    try {',
'      if (RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null) != 0) return res;',
'      uint needed = 0, reasons = 0, count = 0;',
'      RmGetList(session, out needed, ref count, null, ref reasons);',
'      if (needed == 0) return res;',
'      var info = new RM_PROCESS_INFO[needed]; count = needed;',
'      if (RmGetList(session, out needed, ref count, info, ref reasons) != 0) return res;',
'      for (int i = 0; i < count; i++) {',
'        var pi = info[i].Process;',
'        string name = "?";',
'        try { name = System.Diagnostics.Process.GetProcessById(pi.dwProcessId).ProcessName; } catch { }',
'        res.Add(pi.dwProcessId + " | " + name + " | " + info[i].strAppName);',
'      }',
'    } finally { RmEndSession(session); }',
'    return res;',
'  }',
'}'
].join('\r\n');
const ps1 = [
"$ErrorActionPreference = 'Stop'",
'Add-Type -TypeDefinition @' + AT,
cs,
AT,
"$locks = [RmLock]::Locking(@('E:\\AI\\vibe-coding\\shuffleMate\\release\\win-unpacked\\resources\\app.asar'))",
"if ($locks.Count -eq 0) { 'NO LOCKING PROCESS REPORTED' } else { $locks }"
].join('\r\n');
fs.writeFileSync('_lock.ps1', ps1);
console.log('ps1 written');
