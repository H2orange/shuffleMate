const fs = require('fs');
let s = fs.readFileSync('_lock.ps1', 'utf8');
const bad = "Add-Type -TypeDefinition @" + String.fromCharCode(39) + String.fromCharCode(39) + "@";
const good = "Add-Type -TypeDefinition @" + String.fromCharCode(39);
if (s.includes(bad)) { s = s.replace(bad, good); }
else {
  const lines = s.split('\r\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Add-Type -TypeDefinition @')) { lines[i] = good; break; }
  }
  s = lines.join('\r\n');
}
fs.writeFileSync('_lock.ps1', s);
console.log(s.split('\r\n').slice(0, 3).join(' || '));
