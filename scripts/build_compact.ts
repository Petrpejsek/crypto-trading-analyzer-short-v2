import fs from 'node:fs'
import type { MarketRawSnapshot } from '../types/market_raw'
import type { FeaturesSnapshot } from '../types/features'
import { computeFeatures } from '../services/features/compute'
import { buildMarketCompact } from '../services/decider/market_compact'

function loadJson<T>(path: string): T | null {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')) as T } catch { return null }
}

async function main() {
  const snap = loadJson<MarketRawSnapshot>('fixtures/market_raw/last_snapshot.json')
    ?? (() => {
      const files = fs.readdirSync('fixtures/market_raw').filter(f => f.startsWith('snapshot_')).sort().reverse()
      return files.length ? loadJson<MarketRawSnapshot>('fixtures/market_raw/' + files[0]) : null
    })()
  if (!snap) { console.error('No snapshot'); process.exit(1) }
  let features = loadJson<FeaturesSnapshot>('fixtures/features/last_features.json')
  if (!features) {
    features = computeFeatures(snap)
  }
  const compact = buildMarketCompact(features, snap)
  process.stdout.write(JSON.stringify(compact))
}

main().catch(e => { console.error(e); process.exit(1) })


