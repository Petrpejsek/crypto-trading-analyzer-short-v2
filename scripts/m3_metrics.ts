import { request } from 'undici'
import { computeFeatures } from '../services/features/compute'
import type { MarketRawSnapshot } from '../types/market_raw'

async function main() {
  const res = await request('http://localhost:8788/api/snapshot', { method: 'GET' })
  if (res.statusCode !== 200) throw new Error(`snapshot HTTP ${res.statusCode}`)
  const text = await res.body.text()
  const snapshot = JSON.parse(text) as any as MarketRawSnapshot & { duration_ms?: number; latency_ms?: number }
  const t0 = performance.now()
  const features = computeFeatures(snapshot)
  const featuresMs = Math.round(performance.now() - t0)
  const durationMs = Math.round((snapshot as any).duration_ms ?? (snapshot as any).latency_ms ?? 0)
  const symbols = 2 + (snapshot.universe?.length ?? 0)
  console.log(JSON.stringify({ durationMs, featuresMs, symbols }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })


