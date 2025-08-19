import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { computeFeatures } from '../services/features/compute'
import type { MarketRawSnapshot } from '../types/market_raw'
import type { FeaturesSnapshot, EmaOrder } from '../types/features'

const ROOT = process.cwd()

async function readLatestJson(dir: string): Promise<any | null> {
  try {
    const full = path.resolve(ROOT, dir)
    const entries = await fs.readdir(full)
    const files = entries.filter(f => f.endsWith('.json')).map(f => path.join(full, f))
    if (files.length === 0) return null
    const stats = await Promise.all(files.map(async f => ({ f, stat: await fs.stat(f) })))
    stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    const latest = stats[0].f
    const raw = await fs.readFile(latest, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function isFiniteNumbers(obj: any, pathKey = ''): string[] {
  const issues: string[] = []
  if (obj == null) return issues
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) issues.push(pathKey)
    return issues
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => issues.push(...isFiniteNumbers(v, `${pathKey}[${i}]`)))
    return issues
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) issues.push(...isFiniteNumbers(v, pathKey ? `${pathKey}.${k}` : k))
    return issues
  }
  return issues
}

async function main() {
  // Prefer fixtures export; localStorage is not accessible here
  const snapshot: MarketRawSnapshot | null = await readLatestJson('fixtures/market_raw')
  const featuresFile: FeaturesSnapshot | null = await readLatestJson('fixtures/features')

  const reasons: string[] = []
  let qaOk = true

  if (!snapshot) {
    console.error('No MarketRawSnapshot found in fixtures/market_raw')
    process.exit(1)
  }

  // Snapshot checks
  const snapshotSize = Buffer.byteLength(JSON.stringify(snapshot))
  const snapMs = Math.round((snapshot as any).duration_ms ?? (snapshot as any).latency_ms ?? 0)
  if (!(snapMs <= 2000)) { qaOk = false; reasons.push('snapshot.duration>2.0s') }
  if (!((snapshot.universe?.length ?? 0) >= 30)) { qaOk = false; reasons.push('symbols<30') }
  if (!(snapshotSize <= 2.5e6)) { qaOk = false; reasons.push('snapshot>2.5MB') }

  // Features checks
  let features: FeaturesSnapshot | null = featuresFile
  let featuresMs = 0
  if (!features) {
    const t0 = performance.now()
    features = computeFeatures(snapshot)
    featuresMs = performance.now() - t0
  } else {
    // measure compute time anyway from snapshot
    const t0 = performance.now()
    computeFeatures(snapshot)
    featuresMs = performance.now() - t0
  }
  const featuresSize = Buffer.byteLength(JSON.stringify(features))

  if (!(featuresMs < 100)) { qaOk = false; reasons.push('featuresMs>=100ms') }
  if (!(featuresSize <= 200 * 1024)) { qaOk = false; reasons.push('features>200kB') }

  // Breadth range
  const br = features.breadth?.pct_above_EMA50_H1
  if (!(typeof br === 'number' && br >= 0 && br <= 100)) { qaOk = false; reasons.push('breadth_out_of_range') }

  // EMA order enums
  const allowed: Set<EmaOrder> = new Set(['20>50>200','20>200>50','50>20>200','50>200>20','200>20>50','200>50>20'])
  for (const row of features.universe) {
    if (row.ema_order_H1 && !allowed.has(row.ema_order_H1)) { qaOk = false; reasons.push('ema_order_H1_invalid'); break }
    if (row.ema_order_M15 && !allowed.has(row.ema_order_M15)) { qaOk = false; reasons.push('ema_order_M15_invalid'); break }
  }

  // No NaN/Infinity
  const numIssues = isFiniteNumbers(features)
  if (numIssues.length > 0) { qaOk = false; reasons.push('NaN_or_Infinity_in_features') }

  console.table({
    snapshotMs: snapMs,
    featuresMs: Math.round(featuresMs),
    symbols: snapshot.universe.length,
    snapshotSizeKB: +(snapshotSize/1024).toFixed(1),
    featuresSizeKB: +(featuresSize/1024).toFixed(1)
  })
  console.log(`QA_M2_GO: ${qaOk ? 'YES' : 'NO'}${reasons.length ? ' | ' + reasons.join(',') : ''}`)
}

main().catch((e) => { console.error(e); process.exit(1) })


