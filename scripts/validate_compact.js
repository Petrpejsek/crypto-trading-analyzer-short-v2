const fs=require('fs');
const Ajv=require('ajv');
const addFormats=require('ajv-formats');
const schema=JSON.parse(fs.readFileSync('schemas/market_compact.schema.json','utf8'));
const obj=JSON.parse(fs.readFileSync('/tmp/compact.json','utf8'));
const ajv=new Ajv({allErrors:true, strict:false});
addFormats(ajv);
const validate=ajv.compile(schema);
const ok=validate(obj);
if(ok){ console.log('COMPACT OK ✅'); process.exit(0); }
console.log('COMPACT INVALID ❌');
for (const e of validate.errors||[]) {
  console.log(`- path:${e.instancePath||'(root)'} msg:${e.message} params:${JSON.stringify(e.params)}`);
}
process.exit(1);


