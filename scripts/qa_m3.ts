import http from 'node:http'

function post(url: string, data: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: Number(u.port || 8888), path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8')
        try { resolve({ status: res.statusCode || 0, body: JSON.parse(txt || '{}') }) } catch { resolve({ status: res.statusCode || 0, body: null }) }
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(data))
  })
}

async function main() {
  const compact = { timestamp: Date.now(), feeds_ok: true, breadth_pct_H1: 62, avg_volume24h_usd_topN: 10000000, data_warnings: [], btc: { h1: { vwap_rel: 1.01, ema20_gt_50: true, ema50_gt_200: true, rsi: 56, atr_pct: 1.2 }, h4: { ema50_gt_200: true } }, eth: { h1: { vwap_rel: 1.02, ema20_gt_50: true, ema50_gt_200: true, rsi: 58, atr_pct: 1.1 }, h4: { ema50_gt_200: true } } }
  const res = await post('http://localhost:8888/api/decide', compact)
  const hasErr = Array.isArray(res.body?.reasons) && res.body.reasons.some((r: string) => String(r).startsWith('gpt_error:openai_invalid_request'))
  const ok = res.status === 200 && !hasErr
  if (ok) console.log(JSON.stringify({ ok: true, latencyMs: res.body?.meta?.latencyMs ?? 0 }))
  else console.log(JSON.stringify({ ok: false, code: (res.body?.reasons?.[0]||'').replace('gpt_error:',''), http_status: res.body?.meta?.http_status ?? null, http_error: res.body?.meta?.http_error ?? null }))
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })


