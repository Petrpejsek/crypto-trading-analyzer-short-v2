import { promises as fs } from 'node:fs'
import path from 'node:path'
import { selectCandidates } from '../services/signals/candidate_selector'
import { buildSignalSet } from '../services/signals/rules_signals'
import type { FeaturesSnapshot } from '../types/features'
import { decideFromFeatures } from '../services/decider/rules_decider'

function ts() {
  const d = new Date(); const p = (n:number)=>String(n).padStart(2,'0')
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function readLatest(dir: string): Promise<string | null> {
  const abs = path.resolve(process.cwd(), dir)
  try {
    const files = (await fs.readdir(abs)).filter(f=>f.endsWith('.json')).map(f=>path.join(abs,f))
    if (!files.length) return null
    const stats = await Promise.all(files.map(async f=>({f,s:await fs.stat(f)})))
    stats.sort((a,b)=>b.s.mtimeMs - a.s.mtimeMs)
    return stats[0].f
  } catch { return null }
}

async function main() {
  const fPath = (await readLatest('fixtures/features'))
  if (!fPath) { console.log('No features fixture'); process.exit(0) }
  const feats: FeaturesSnapshot = JSON.parse(await fs.readFile(fPath,'utf8'))
  const dec = decideFromFeatures(feats)
  const cands = selectCandidates(feats, dec)
  const set = buildSignalSet(feats, dec, cands)
  const outDir = path.resolve(process.cwd(), 'fixtures/signals')
  await fs.mkdir(outDir, { recursive: true })
  const out = path.join(outDir, `signals_${ts()}.json`)
  await fs.writeFile(out, JSON.stringify(set))
  console.log('Exported signals to', out, 'count=', set.setups.length)
}

main().catch(e=>{ console.error(e); process.exit(1) })


