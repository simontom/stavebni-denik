const fs = require('fs');
const path = require('path');

function walkDir(dir) {
    let files = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const entry = path.join(dir, d.name);
        if (d.isDirectory()) {
            files = files.concat(walkDir(entry));
        } else if (d.isFile() && entry.endsWith('.ts')) {
            files.push(entry);
        }
    }
    return files;
}

const files = [...walkDir('src'), ...walkDir('test')];

for (const file of files) {
  if (file.includes('reports-sequence.int.test.ts')) continue;
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
  
  if (file.includes('test\\integration') || file.includes('test/integration')) {
    if (content.includes('workDescription:')) {
       // Only inject if missing
       const lines = content.split('\n');
       for (let i = 0; i < lines.length; i++) {
           if (lines[i].includes('workDescription:') && !lines[i].includes('sequenceNumber:') && !content.includes('createReport(')) {
               lines[i] = lines[i].replace('workDescription:', 'sequenceNumber: 1, isControlDay: false, constructionObj: null, workDescription:');
               changed = true;
           }
       }
       content = lines.join('\n');
    }
  }

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
  }
}
