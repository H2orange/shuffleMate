const fs = require('fs');
let s = fs.readFileSync('_handles.ps1', 'utf8');
const oldLine = 'if (tname != "File") continue;';
const newLine = 'if (tname != "File" && tname != "Section") continue;';
if (!s.includes(oldLine)) throw new Error('line not found');
s = s.replace(oldLine, newLine);
fs.writeFileSync('_handles.ps1', s);
console.log('scanner updated');
