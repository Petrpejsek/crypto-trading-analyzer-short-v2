const fs = require('fs');
const path = process.argv[2] || '/tmp/decide_B.json';
try {
  const j = JSON.parse(fs.readFileSync(path, 'utf8'));
  console.log(`${j.flag} | ${j.posture} | health=${j.market_health}`);
} catch {
  console.log('parse_fail');
}


