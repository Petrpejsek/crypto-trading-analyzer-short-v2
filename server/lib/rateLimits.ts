// Centralized Binance API rate limit and error diagnostics monitor
// Tracks recent calls, parses Binance-specific headers and error codes,
// and exposes a snapshot for UI and debugging.

type HeadersLike = Headers | Record<string, string | string[] | undefined> | null | undefined

type ApiCallSample = {
  ts: number
  method: string
  path: string
  status: number
  weight1m: number | null
  orderCount10s: number | null
  orderCount1m: number | null
  retryAfterSec: number | null
  errorCode: number | null
  errorMsg: string | null
}

const samples: ApiCallSample[] = []
const MAX_SAMPLES = 800

let lastUsedWeight1m: number | null = null
let lastOrderCount10s: number | null = null
let lastOrderCount1m: number | null = null
let last429AtMs: number | null = null
let last1003AtMs: number | null = null
let banUntilMs: number | null = null

function toNum(x: any): number | null {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function headersToObj(h: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  try {
    if (typeof (h as any).forEach === 'function') {
      ;(h as Headers).forEach((v, k) => { out[String(k).toLowerCase()] = String(v) })
      return out
    }
    const obj = h as Record<string, string | string[] | undefined>
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (Array.isArray(v)) out[String(k).toLowerCase()] = String(v[v.length - 1])
      else if (typeof v !== 'undefined') out[String(k).toLowerCase()] = String(v)
    }
  } catch {}
  return out
}

function prune(): void {
  try {
    const cutoff = Date.now() - 5 * 60 * 1000
    while (samples.length && samples[0].ts < cutoff) samples.shift()
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  } catch {}
}

export function setBanUntilMs(ts: number | null): void {
  try {
    if (ts == null) { banUntilMs = null; return }
    const n = Number(ts)
    if (Number.isFinite(n) && n > Date.now()) banUntilMs = n
  } catch {}
}

export function noteApiCall(input: {
  method: string
  path: string
  status: number
  headers?: HeadersLike
  retryAfterSec?: number | null
  errorCode?: number | null
  errorMsg?: string | null
}): void {
  try {
    const ts = Date.now()
    const H = headersToObj(input.headers)
    const w = toNum(H['x-mbx-used-weight-1m'])
    const oc10 = toNum(H['x-mbx-order-count-10s'])
    const oc1m = toNum(H['x-mbx-order-count-1m'])
    if (w != null) lastUsedWeight1m = w
    if (oc10 != null) lastOrderCount10s = oc10
    if (oc1m != null) lastOrderCount1m = oc1m

    const retryHdr = toNum(H['retry-after'])
    const retryAfterSec = input.retryAfterSec != null ? (Number(input.retryAfterSec) || null) : (retryHdr != null ? retryHdr : null)

    // Track ban/backoff window
    if (input.status === 429) {
      last429AtMs = ts
      const until = retryAfterSec != null ? (ts + Math.max(1, retryAfterSec) * 1000) : null
      if (until && (!banUntilMs || until > (banUntilMs as number))) banUntilMs = until
    }

    const code = input.errorCode != null ? Number(input.errorCode) : null
    const msg = String(input.errorMsg || '')
    if (code === -1003) {
      last1003AtMs = ts
      // Detect "banned until <epochMs>" in message (server-side convention)
      const m = msg.match(/banned\s+until\s+(\d{10,})/i)
      if (m && m[1]) {
        const until = Number(m[1])
        if (Number.isFinite(until) && until > ts) banUntilMs = until
      }
    }

    samples.push({
      ts,
      method: String(input.method || '').toUpperCase(),
      path: String(input.path || ''),
      status: Number(input.status || 0),
      weight1m: w,
      orderCount10s: oc10,
      orderCount1m: oc1m,
      retryAfterSec,
      errorCode: code,
      errorMsg: msg || null
    })
    prune()
  } catch {}
}

export function getLimitsSnapshot(): any {
  prune()
  const now = Date.now()
  const inWindow = (ms: number) => samples.filter(s => (now - s.ts) <= ms)
  const last1s = inWindow(1000)
  const last10s = inWindow(10_000)
  const last60s = inWindow(60_000)

  const recent = samples.slice(-24).map(s => ({
    t: new Date(s.ts).toISOString(),
    m: s.method,
    p: s.path,
    st: s.status,
    w1m: s.weight1m,
    oc10: s.orderCount10s,
    oc1m: s.orderCount1m,
    ra: s.retryAfterSec,
    ec: s.errorCode
  }))

  const byPath: Record<string, { count: number; lastStatus: number; lastWeight1m: number | null }> = {}
  for (const s of last60s) {
    const key = String(s.path || '')
    if (!byPath[key]) byPath[key] = { count: 0, lastStatus: s.status, lastWeight1m: s.weight1m }
    byPath[key].count += 1
    byPath[key].lastStatus = s.status
    if (s.weight1m != null) byPath[key].lastWeight1m = s.weight1m
  }

  // Compute max used weight in the last 60s window (more representative than just last seen)
  let maxUsedWeight1mLast60s: number | null = null
  try {
    for (const s of last60s) {
      const w = Number(s.weight1m)
      if (Number.isFinite(w)) {
        if (maxUsedWeight1mLast60s == null || w > (maxUsedWeight1mLast60s as number)) maxUsedWeight1mLast60s = w
      }
    }
  } catch {}

  const riskLevel = (() => {
    // Heuristics: elevate risk if we recently saw 429/-1003 or high order counts
    const recent429 = last429AtMs && (now - last429AtMs) < 60_000
    const recent1003 = last1003AtMs && (now - last1003AtMs) < 300_000
    const highWeight = (lastUsedWeight1m || 0) > 1100 // Binance docs typical soft cap ~1200/1m
    const highOrderBurst = (lastOrderCount10s || 0) > 40 // strict per-account WS/REST guidance (heuristic)
    if (recent429 || recent1003) return 'critical'
    if (highWeight || highOrderBurst) return 'elevated'
    return 'normal'
  })()

  const until = Number(banUntilMs || 0)
  const backoff = Number.isFinite(until) && until > now ? { untilMs: until, remainingSec: Math.ceil((until - now) / 1000) } : null

  return {
    now: new Date(now).toISOString(),
    risk: riskLevel,
    backoff,
    last429AtMs,
    last1003AtMs,
    lastUsedWeight1m,
    maxUsedWeight1mLast60s,
    lastOrderCount10s,
    lastOrderCount1m,
    callRate: {
      per1s: last1s.length,
      per10s: last10s.length,
      per60s: last60s.length
    },
    byPath,
    recent
  }
}


