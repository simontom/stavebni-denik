const fs = require('fs');
const glob = require('glob');
// Wait, glob is not installed. I will use the recursive walkDir function again.
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

const files = [...walkDir('src'), ...walkDir('test')];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;
  if (content.includes('type Role = "BOSS" | "WORKER" | "INSPECTOR";')) {
    content = content.replace(/type Role = "BOSS" \| "WORKER" \| "INSPECTOR";/g, 'type Role = "BOSS" | "WORKER" | "INSPECTOR" | "INVESTOR";');
    changed = true;
  }
  
  if (content.includes('BOSS: "Stavbyvedoucí",') && content.includes('INSPECTOR:')) {
    if (!content.includes('INVESTOR:')) {
      content = content.replace(/INSPECTOR:([^\n]+),/g, 'INSPECTOR:$1,\n  INVESTOR: "Investor",');
      changed = true;
    }
  }

  if (content.includes('report.acknowledge')) {
    // Wait, audit action type error!
    if (content.includes('type AuditAction =')) {
        content = content.replace(/'report\.delete' \|/g, "'report.delete' |\n  'report.acknowledge' |");
        changed = true;
    }
  }
  
  // Clean duplicate properties in object literals
  if (content.includes('designerName: null,\n    contractNumber: null')) {
     const clean = content.replace(/designerName: null,\n    contractNumber: null,\n    contractDate: null,\n    designDocVersion: null,\n    designDocDate: null,/g, '');
     if (clean !== content) {
       // Wait, I messed up duplicate properties
     }
  }

  if (changed) {
    fs.writeFileSync(file, content, 'utf8');
  }
}
