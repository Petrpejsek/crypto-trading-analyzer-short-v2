import { promises as fs } from 'node:fs'
import path from 'node:path'
import { computeFeatures } from '../services/features/compute'
import type { MarketRawSnapshot } from '../types/market_raw'

function ts() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true })
}

async function main() {
  const base = process.cwd()
  const m1Dir = path.join(base, 'fixtures/market_raw')
  const m2Dir = path.join(base, 'fixtures/features')
  await ensureDir(m1Dir)
  await ensureDir(m2Dir)

  const res = await fetch('http://localhost:8888/api/snapshot', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching snapshot`)
  const snapshot: MarketRawSnapshot = await res.json()
  const fn1 = path.join(m1Dir, `snapshot_${ts()}.json`)
  await fs.writeFile(fn1, JSON.stringify(snapshot))

  const feats = computeFeatures(snapshot)
  const fn2 = path.join(m2Dir, `features_${ts()}.json`)
  await fs.writeFile(fn2, JSON.stringify(feats))
  console.log('Exported:', fn1, 'and', fn2)
}

main().catch((e) => { console.error(e); process.exit(1) })


