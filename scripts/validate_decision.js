const fs=require('fs');
const Ajv=require('ajv');
const addFormats=require('ajv-formats');
const schema=JSON.parse(fs.readFileSync('schemas/market_decision.schema.json','utf8'));
const obj=JSON.parse(fs.readFileSync(process.argv[2]||'/tmp/decide_B.json','utf8'));
const ajv=new Ajv({allErrors:true, strict:false});
addFormats(ajv);
const validate=ajv.compile(schema);
if (validate(obj)) { console.log('DECISION OK ✅'); process.exit(0); }
console.log('DECISION INVALID ❌');
for (const e of validate.errors||[]) console.log(`- path:${e.instancePath||'(root)'} msg:${e.message} params:${JSON.stringify(e.params)}`);
process.exit(1);


