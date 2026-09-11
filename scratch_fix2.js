const fs = require('fs');
const path = require('path');

function walkDir(dir) {
    let files = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const entry = path.join(dir, d.name);
        if (d.isDirectory()) {
            files = files.concat(walkDir(entry));
        } else if (d.isFile() && (entry.endsWith('.tsx') || entry.endsWith('.ts'))) {
            files.push(entry);
        }
    }
    return files;
}

const files = walkDir('src');

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;
  if (content.includes('"GUEST"')) {
    content = content.replace(/"GUEST"/g, '"INSPECTOR"');
    changed = true;
  }
  if (content.includes("'GUEST'")) {
    content = content.replace(/'GUEST'/g, "'INSPECTOR'");
    changed = true;
  }
  if (content.includes('GUEST:')) {
    content = content.replace(/GUEST:/g, 'INSPECTOR:');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
  }
}
