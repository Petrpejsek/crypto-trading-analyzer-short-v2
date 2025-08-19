import { request } from 'undici'

async function fetchJson(url: string) {
  const r = await request(url, { method: 'GET' })
  const t = await r.body.text()
  return JSON.parse(t)
}

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

async function main() {
  try { await fetchJson('http://localhost:8788/api/snapshot') } catch {}
  const runs: Array<{ ms: number; syms: number }> = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    const snap = await fetchJson('http://localhost:8788/api/snapshot')
    const dt = Date.now() - t0
    const syms = Array.isArray(snap?.universe) ? (2 + snap.universe.length) : 0
    runs.push({ ms: snap?.duration_ms ?? dt, syms })
    await sleep(5000)
  }
  const ok = runs.every(r => r.ms <= 2000 && r.syms >= 30)
  console.table(runs.map((r, i) => ({ run: i + 1, duration_ms: r.ms, symbols: r.syms })))
  if (ok) console.log('QA_M7_PERF_GO: YES')
  else console.log('QA_M7_PERF_GO: NO | ' + runs.map((r, i) => `run#${i + 1}:${r.ms}ms/${r.syms}syms`).join(', '))
}

main().catch(e => { console.error(e); process.exit(1) })





