import { request } from 'undici'
import { computeFeatures } from '../services/features/compute'
import type { MarketRawSnapshot } from '../types/market_raw'

async function main() {
  const snapRes = await request('http://localhost:8788/api/snapshot', { method: 'GET' })
  if (snapRes.statusCode !== 200) throw new Error(`snapshot HTTP ${snapRes.statusCode}`)
  const snapTxt = await snapRes.body.text()
  const snapshot = JSON.parse(snapTxt) as MarketRawSnapshot
  const features = computeFeatures(snapshot)
  const decideRes = await request('http://localhost:8788/api/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ features, snapshot })
  })
  const decTxt = await decideRes.body.text()
  const decision = JSON.parse(decTxt)
  console.log(JSON.stringify({ ok: true, decision }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })


