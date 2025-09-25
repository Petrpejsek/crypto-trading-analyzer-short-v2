const fs = require('fs');
const path = process.argv[2] || '/tmp/decide_B.json';
try {
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log((j.reasons && j.reasons[0]) || 'missing_reason');
} catch {
  console.log('missing_reason');
}


