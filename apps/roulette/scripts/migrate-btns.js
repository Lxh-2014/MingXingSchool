// 批量替换按钮类名
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'client', 'pages');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const rules = [
  // btn-primary → btn-column2（主操作）
  [/btn-primary\b/g, 'btn-column2'],
  // btn-outline / btn-ghost / btn-secondary → btn-column5（通用）
  [/btn-outline\b/g, 'btn-column5'],
  [/btn-ghost\b/g, 'btn-column5'],
  [/btn-secondary\b/g, 'btn-column5'],
  // btn-destructive → btn-column4（危险）
  [/btn-destructive\b/g, 'btn-column4'],
];

for (const f of files) {
  let c = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const [re, rep] of rules) c = c.replace(re, rep);
  fs.writeFileSync(path.join(dir, f), c, 'utf8');
  console.log('updated btn classes:', f);
}
