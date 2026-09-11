const fs = require('fs');
const files = [
  'src/server/permissions.ts',
  'src/app/(app)/admin/users/EditUserDialog.tsx',
  'src/app/(app)/projects/[id]/MembersPanel.tsx'
];
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/type Role = "BOSS" \| "WORKER" \| "INSPECTOR";/g, 'type Role = "BOSS" | "WORKER" | "INSPECTOR" | "INVESTOR";');
  fs.writeFileSync(file, content, 'utf8');
}
