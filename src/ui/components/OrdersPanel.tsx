import React, { useEffect, useMemo, useRef, useState } from 'react'

type OpenOrderUI = {
  orderId: number
  symbol: string
  side: 'BUY' | 'SELL' | string
  type: string
  qty: number | null
  price: number | null
  stopPrice: number | null
  timeInForce: string | null
  reduceOnly: boolean
  closePosition: boolean
  positionSide?: 'LONG' | 'SHORT' | string | null
  createdAt?: string | null
  updatedAt: string | null
}

type WaitingOrderUI = {
  symbol: string
  tp: number
  qtyPlanned: string | null
  since: string
  lastCheck: string | null
  checks: number
  positionSize: number | null
  status: 'waiting'
  positionSide?: 'LONG' | 'SHORT' | string | null
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE' | string | null
  lastError?: string | null
  lastErrorAt?: string | null
}

type PositionUI = {
  symbol: string
  positionSide: 'LONG' | 'SHORT' | string | null
  size: number
  entryPrice: number | null
  markPrice: number | null
  unrealizedPnl: number | null
  leverage: number | null
  updatedAt: string | null
}

const POLL_MS = 5000

export const OrdersPanel: React.FC = () => {
  const [orders, setOrders] = useState<OpenOrderUI[]>([])
  const [positions, setPositions] = useState<PositionUI[]>([])
  const [waiting, setWaiting] = useState<WaitingOrderUI[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const [marks, setMarks] = useState<Record<string, number>>({})
  const [lastAmountBySymbol, setLastAmountBySymbol] = useState<Record<string, number>>({})
  const [lastLeverageBySymbol, setLastLeverageBySymbol] = useState<Record<string, number>>({})
  const [cancellingIds, setCancellingIds] = useState<Set<number>>(new Set())
  const [backoffUntilMs, setBackoffUntilMs] = useState<number | null>(null)
  const [pendingCancelAgeMin, setPendingCancelAgeMin] = useState<number>(() => {
    try { const v = localStorage.getItem('pending_cancel_age_min'); const n = v == null ? 0 : Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 } catch { return 0 }
  })

  // Source of truth is the server – sync on mount
  const syncPendingCancelFromServer = async (): Promise<void> => {
    try {
      const r = await fetchJson('/api/trading/settings', { timeoutMs: 30000 })
      if (r.ok) {
        const srv = Number((r.json as any)?.pending_cancel_age_min)
        const val = Number.isFinite(srv) && srv >= 0 ? Math.floor(srv) : 0
        setPendingCancelAgeMin(val)
        try { localStorage.setItem('pending_cancel_age_min', String(val)) } catch {}
      }
    } catch {}
  }

  const fetchJson = async (input: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ ok: boolean; status: number; json: any | null }> => {
    const ac = new AbortController()
    const tm = init?.timeoutMs ?? 30000
    const timeout = window.setTimeout(() => {
      try { ac.abort(new DOMException(`timeout after ${tm}ms`, 'TimeoutError')) } catch { ac.abort() }
    }, tm)
    try {
      const res = await fetch(input, { ...(init || {}), signal: ac.signal })
      const status = res.status
      let json: any = null
      try { json = await res.json() } catch {}
      return { ok: res.ok, status, json }
    } finally {
      clearTimeout(timeout)
    }
  }

  const load = async () => {
    if (loading) return
    if (Number.isFinite(backoffUntilMs as any) && (backoffUntilMs as number) > Date.now()) {
      // During Binance ban window: skip hitting API
      setLastRefresh(new Date().toISOString())
      return
    }
    setLoading(true)
    setError(null)
    try {
      const cons = await fetchJson('/api/orders_console', { timeoutMs: 30000 })
      if (!cons.ok) {
        const code = cons.status === 401 && cons.json?.error === 'missing_binance_keys' ? 'missing_binance_keys' : (cons.json?.error || `HTTP ${cons.status}`)
        setOrders([]); setWaiting([]); setPositions([])
        setLastRefresh(new Date().toISOString())
        setLoading(false)
        // Nahlásíme pouze missing keys, ostatní (WS not ready) potichu ignorujeme
        if (code === 'missing_binance_keys') throw new Error(`orders_console:${code}`)
        return
      }
      const json = cons.json || {}
      const ordersArr: OpenOrderUI[] = Array.isArray(json?.open_orders) ? json.open_orders : []
      const waitingArr: WaitingOrderUI[] = Array.isArray(json?.waiting) ? json.waiting : []
      const positionsArr: PositionUI[] = Array.isArray(json?.positions) ? json.positions : []
      const marksObj: Record<string, number> = (json?.marks && typeof json.marks === 'object') ? json.marks : {}
      setOrders(ordersArr)
      setWaiting(waitingArr)
      setPositions(positionsArr)
      // Build symbol -> amount map from last place_orders debug snapshot
      try {
        const req = json?.last_place?.request
        const list: any[] = Array.isArray(req?.orders) ? req.orders : []
        const mapAmt: Record<string, number> = {}
        const mapLev: Record<string, number> = {}
        for (const o of list) {
          const sym = String(o?.symbol || '')
          const amt = Number(o?.amount)
          const lev = Number(o?.leverage)
          if (sym && Number.isFinite(amt) && amt > 0) mapAmt[sym] = amt
          if (sym && Number.isFinite(lev) && lev > 0) mapLev[sym] = Math.floor(lev)
        }
        setLastAmountBySymbol(mapAmt)
        setLastLeverageBySymbol(mapLev)
      } catch {}
      // Handshake: if server indicates auto-cancel happened, disable locally and on server
      try {
        if (json && json.auto_cancelled_due_to_age) {
          localStorage.removeItem('pending_cancel_age_min')
          setPendingCancelAgeMin(0)
          await fetchJson('/api/trading/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending_cancel_age_min: 0 }), timeoutMs: 30000 })
        }
      } catch {}
      // Update marks from WS snapshot (no per-symbol REST calls)
      try { if (marksObj && typeof marksObj === 'object') setMarks(marksObj) } catch {}
      setLastRefresh(new Date().toISOString())
    } catch (e: any) {
      const msg = String(e?.message || 'unknown_error')
      setError(msg)
      try {
        // If rate limited/banned, pause polling until ban expires
        const m = msg.match(/banned\s+until\s+(\d{10,})/i)
        if (m && m[1]) {
          const until = Number(m[1])
          if (Number.isFinite(until) && until > Date.now()) {
            setBackoffUntilMs(prev => {
              const prevVal = Number(prev)
              return Number.isFinite(prevVal) && prevVal > Date.now() ? Math.max(prevVal, until) : until
            })
          }
        } else if (/code\":-?1003|too\s+many\s+requests|status:\s*418/i.test(msg)) {
          // Only start a 60s backoff if we are not already backing off
          setBackoffUntilMs(prev => {
            const prevVal = Number(prev)
            if (Number.isFinite(prevVal) && prevVal > Date.now()) return prevVal
            return Date.now() + 60000
          })
        }
      } catch {}
    } finally {
      setLoading(false)
    }
  }

  const refreshMarksLimited = async () => { /* no-op: marks are delivered via /api/orders_console */ }

  const cancelOne = async (symbol: string, orderId: number) => {
    try {
      setCancellingIds(prev => { const n = new Set(prev); n.add(orderId); return n })
      const r = await fetch(`/api/order?symbol=${encodeURIComponent(symbol)}&orderId=${encodeURIComponent(String(orderId))}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = await r.json().catch(()=>null)
        throw new Error(String(j?.error || `HTTP ${r.status}`))
      }
      await load()
    } catch (e:any) {
      setError(`cancel_failed:${symbol}:${orderId}:${e?.message || 'unknown'}`)
    } finally {
      setCancellingIds(prev => { const n = new Set(prev); n.delete(orderId); return n })
    }
  }

  const cancelAllOpenOrders = async () => {
    try {
      const ok = window.confirm('Cancel ALL visible open orders?')
      if (!ok) return
      const ids = orders.map(o => ({ symbol: o.symbol, id: o.orderId })).filter(x => x.id)
      setCancellingIds(new Set(ids.map(x => x.id)))
      await Promise.allSettled(ids.map(x => fetch(`/api/order?symbol=${encodeURIComponent(x.symbol)}&orderId=${encodeURIComponent(String(x.id))}`, { method: 'DELETE' })))
      await load()
    } catch (e:any) {
      setError(`cancel_all_failed:${e?.message || 'unknown'}`)
    } finally {
      setCancellingIds(new Set())
    }
  }

  // Stable ordering to avoid row jumping on refresh
  const getOrderCategory = (o: OpenOrderUI): 1 | 2 | 3 | 4 => {
    try {
      const t = String(o.type || '').toUpperCase()
      const isTP = t.includes('TAKE_PROFIT')
      const isSL = t.includes('STOP') && !isTP
      const isEntry = String(o.side || '').toUpperCase() === 'BUY' && !(o.reduceOnly || o.closePosition)
      if (isEntry) return 1
      if (isSL) return 2
      if (isTP) return 3
      return 4
    } catch { return 4 }
  }
  const stableOrders = useMemo(() => {
    const list = Array.isArray(orders) ? [...orders] : []
    list.sort((a, b) => {
      if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol)
      const ca = getOrderCategory(a)
      const cb = getOrderCategory(b)
      if (ca !== cb) return ca - cb
      const sa = String(a.side || '')
      const sb = String(b.side || '')
      if (sa !== sb) return sa.localeCompare(sb)
      const ta = String(a.type || '')
      const tb = String(b.type || '')
      if (ta !== tb) return ta.localeCompare(tb)
      return Number(a.orderId) - Number(b.orderId)
    })
    return list
  }, [orders])

  const stableWaiting = useMemo(() => {
    const list = Array.isArray(waiting) ? [...waiting] : []
    list.sort((a, b) => a.symbol.localeCompare(b.symbol))
    return list
  }, [waiting])

  const flattenOne = async (symbol: string, side: string | null | undefined) => {
    try {
      const s = String(side || 'LONG').toUpperCase()
      const r = await fetch(`/__proxy/binance/flatten?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(s)}`, { method: 'POST' })
      if (!r.ok) {
        const t = await r.text().catch(()=> '')
        throw new Error(t || `HTTP ${r.status}`)
      }
      await load()
    } catch (e:any) {
      setError(`flatten_failed:${symbol}:${e?.message || 'unknown'}`)
    }
  }

  const flattenAllPositions = async () => {
    try {
      if (!positions || positions.length === 0) return
      const ok = window.confirm(`Flatten ALL ${positions.length} positions?`)
      if (!ok) return
      await Promise.allSettled(
        positions.map(p => fetch(`/__proxy/binance/flatten?symbol=${encodeURIComponent(p.symbol)}&side=${encodeURIComponent(String(p.positionSide||'LONG'))}`, { method: 'POST' }))
      )
      await load()
    } catch (e:any) {
      setError(`flatten_all_failed:${e?.message || 'unknown'}`)
    }
  }

  useEffect(() => {
    let mounted = true
    ;(async () => { if (mounted) { await syncPendingCancelFromServer(); await load() } })()
    timerRef.current = window.setInterval(load, POLL_MS)
    return () => {
      mounted = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fmtNum = (n: number | null | undefined, dp = 6): string => {
    try { return Number.isFinite(n as any) ? (n as number).toFixed(dp) : '-' } catch { return '-' }
  }
  const fmtPct = (n: number | null | undefined, dp = 2): string => {
    try { return Number.isFinite(n as any) ? `${(n as number).toFixed(dp)}%` : '-' } catch { return '-' }
  }
  const colorForDelta = (pct: number | null | undefined): string | undefined => {
    try {
      const v = Number(pct)
      if (!Number.isFinite(v)) return undefined
      if (v < 0.5) return '#16a34a' // green (<0.5%)
      if (v <= 1.5) return '#f59e0b' // amber (0.5–1.5%)
      return '#dc2626' // red (>1.5%)
    } catch { return undefined }
  }

  const ageMinutes = (iso: string | null | undefined): number | null => {
    try {
      if (!iso) return null
      const t = new Date(iso).getTime()
      if (!Number.isFinite(t)) return null
      const diffMs = Date.now() - t
      if (diffMs < 0) return 0
      return Math.floor(diffMs / 60000)
    } catch { return null }
  }
  const colorForAge = (min: number | null | undefined): string | undefined => {
    try {
      const v = Number(min)
      if (!Number.isFinite(v)) return undefined
      const x = Number(pendingCancelAgeMin)
      if (Number.isFinite(x) && x > 0) {
        if (v <= x) return '#16a34a'
        if (v <= 2 * x) return '#f59e0b'
        return '#dc2626'
      } else {
        if (v <= 40) return '#16a34a'
        if (v <= 60) return '#f59e0b'
        return '#dc2626'
      }
    } catch { return undefined }
  }
  const fmtAge = (min: number | null | undefined): string => {
    try {
      const v = Number(min)
      if (!Number.isFinite(v)) return '-'
      if (v < 60) return `${v}m`
      const h = Math.floor(v / 60)
      const m = v % 60
      return m ? `${h}h ${m}m` : `${h}h`
    } catch { return '-' }
  }

  const onChangePendingCancel = async (val: number) => {
    try {
      const prev = pendingCancelAgeMin
      setPendingCancelAgeMin(val)
      const r = await fetchJson('/api/trading/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending_cancel_age_min: val }), timeoutMs: 30000 })
      if (!r.ok) { throw new Error(String((r.json as any)?.error || `HTTP ${r.status}`)) }
      try { localStorage.setItem('pending_cancel_age_min', String(val)) } catch {}
    } catch (e: any) {
      setError(`pending_cancel_save_failed:${e?.message || 'unknown'}`)
      // Revert UI to previous value on failure to avoid mismatch
      try {
        const srv = await fetchJson('/api/trading/settings', { timeoutMs: 30000 })
        const v = srv.ok ? Number((srv.json as any)?.pending_cancel_age_min) : NaN
        if (Number.isFinite(v)) {
          setPendingCancelAgeMin(Math.max(0, Math.floor(v)))
        }
      } catch {}
    }
  }

  const pickOrderTargetPrice = (o: OpenOrderUI): number | null => {
    const s1 = Number(o.stopPrice)
    const s2 = Number(o.price)
    if (Number.isFinite(s1) && s1 > 0) return s1
    if (Number.isFinite(s2) && s2 > 0) return s2
    return null
  }

  const positionsView = useMemo(() => {
    return positions.map(p => {
      const entry = Number(p.entryPrice)
      const mark = Number(p.markPrice)
      const size = Number(p.size)
      const side = String(p.positionSide || '')
      const lev = Number(p.leverage)
      let pnlPct: number | null = null
      let pnlUsd: number | null = null
      try {
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(mark) && size > 0) {
          const sign = side === 'SHORT' ? -1 : 1
          pnlPct = sign * ((mark / entry) - 1) * 100
          // Absolute P&L in USDT (LONG-only use-case)
          pnlUsd = (mark - entry) * size * (side === 'SHORT' ? -1 : 1)
        }
      } catch {}
      let pnlPctLev: number | null = null
      try {
        if (Number.isFinite(pnlPct as any) && Number.isFinite(lev) && lev > 0) {
          pnlPctLev = (pnlPct as number) * lev
        }
      } catch {}
      // Margin (invested capital without leverage)
      let marginUsd: number | null = null
      try {
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(size) && size > 0 && Number.isFinite(lev) && lev > 0) {
          marginUsd = (entry * size) / lev
        }
      } catch {}
      // Static closure thresholds (informative): derive from open orders for this symbol
      let slLevPct: number | null = null
      let tpLevPct: number | null = null
      try {
        if (Number.isFinite(entry) && entry > 0 && Array.isArray(orders)) {
          // Consider explicit exit indicators or opposite trade side for this position
          const posSide = String(side || '').toUpperCase()
          const exitSide = posSide === 'SHORT' ? 'BUY' : 'SELL'
          const symOrders = orders.filter(o => {
            const sameSymbol = o.symbol === p.symbol
            const hasCloseFlag = !!(o.closePosition || o.reduceOnly)
            const isExitType = /take_profit/i.test(String(o.type||'')) || (/stop/i.test(String(o.type||'')) && !/take_profit/i.test(String(o.type||'')))
            const isExitSide = String(o.side || '').toUpperCase() === exitSide
            return sameSymbol && (hasCloseFlag || isExitType || isExitSide)
          })
          const exitPxFrom = (o: OpenOrderUI): number | null => {
            const s = Number(o.stopPrice)
            const pr = Number(o.price)
            if (Number.isFinite(s) && s > 0) return s
            if (Number.isFinite(pr) && pr > 0) return pr
            return null
          }
          const isTP = (t: string) => /take_profit/i.test(String(t||''))
          const isSL = (t: string) => /stop/i.test(String(t||'')) && !/take_profit/i.test(String(t||''))
          const slOrder = symOrders.find(o => isSL(o.type))
          const tpOrder = symOrders.find(o => isTP(o.type))
          const sign = side === 'SHORT' ? -1 : 1
          if (slOrder) {
            const px = exitPxFrom(slOrder)
            if (Number.isFinite(px as any) && Number.isFinite(lev) && lev > 0) {
              const raw = sign * (((px as number) / entry) - 1) * 100
              slLevPct = raw * lev
            }
          }
          if (tpOrder) {
            const px = exitPxFrom(tpOrder)
            if (Number.isFinite(px as any) && Number.isFinite(lev) && lev > 0) {
              const raw = sign * (((px as number) / entry) - 1) * 100
              tpLevPct = raw * lev
            }
          }
        }
      } catch {}
      return { ...p, pnlPct, pnlPctLev, pnlUsd, marginUsd, slLevPct, tpLevPct }
    })
  }, [positions, orders])

  return (
    <div className="card" style={{ marginTop: 12, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>Open Positions & Orders (Futures)</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, opacity: .8 }}>
            Auto refresh: {Math.round(POLL_MS/1000)}s{(Number.isFinite(backoffUntilMs as any) && (backoffUntilMs as number) > Date.now()) ? ` (backoff ${Math.max(0, Math.ceil(((backoffUntilMs as number) - Date.now())/1000))}s)` : ''}
          </span>
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          {lastRefresh ? (<span style={{ fontSize: 12, opacity: .7 }}>Last: {new Date(lastRefresh).toLocaleTimeString()}</span>) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: .8 }}>Pending cancel:</span>
            <select value={pendingCancelAgeMin} onChange={e => onChangePendingCancel(Number(e.target.value))} style={{ fontSize: 12 }}>
              <option value={0}>Off</option>
              <option value={30}>30 min</option>
              <option value={40}>40 min</option>
              <option value={60}>60 min</option>
              <option value={90}>90 min</option>
              <option value={120}>120 min</option>
            </select>
          </div>
        </div>
      </div>
      {error ? (
        <div className="error" style={{ marginTop: 8 }}>
          <strong style={{ color: 'crimson' }}>Error:</strong> <span style={{ fontSize: 12 }}>{error}</span>
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Positions</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn" onClick={flattenAllPositions} style={{ background: '#0d3a3a', border: '1px solid #106b6b', color: '#fff', padding: '2px 8px', fontSize: 12 }}>Flatten All</button>
            <span style={{ fontSize: 12, opacity: .8 }}>{positions.length}</span>
          </div>
        </div>
        {positionsView.length === 0 ? (
          <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No open positions</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Symbol</th>
                  <th style={{ textAlign: 'left' }}>Side</th>
                  <th style={{ textAlign: 'right' }}>Size</th>
                  <th style={{ textAlign: 'right' }}>Entry</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Invested $</th>
                  <th style={{ textAlign: 'right' }}>P&L $</th>
                  <th style={{ textAlign: 'right' }}>P&L Lev %</th>
                  <th style={{ textAlign: 'right' }}>P&L %</th>
                  <th style={{ textAlign: 'right' }}>SL Lev % · TP Lev %</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {positionsView.map((p, idx) => {
                  const pnlLevStr = fmtPct((p as any).pnlPctLev, 2)
                  const pnlLevColor = Number((p as any).pnlPctLev) > 0 ? '#16a34a' : Number((p as any).pnlPctLev) < 0 ? '#dc2626' : undefined
                  const slLev = (p as any).slLevPct as number | null
                  const tpLev = (p as any).tpLevPct as number | null
                  const pnlUsdVal = Number((p as any).pnlUsd)
                  const pnlUsdColor = Number.isFinite(pnlUsdVal) ? (pnlUsdVal > 0 ? '#16a34a' : (pnlUsdVal < 0 ? '#dc2626' : undefined)) : undefined
                  const marginUsdVal = Number((p as any).marginUsd)
                  const pnlPctStr = fmtPct((p as any).pnlPct, 2)
                  const pnlPctColor = Number((p as any).pnlPct) > 0 ? '#16a34a' : Number((p as any).pnlPct) < 0 ? '#dc2626' : undefined
                  return (
                    <tr key={`${p.symbol}-${idx}`}>
                      <td>{p.symbol}</td>
                      <td>{p.positionSide}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.size, 4)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.entryPrice, 6)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.markPrice, 6)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(marginUsdVal as any, 2)}</td>
                      <td style={{ textAlign: 'right', color: pnlUsdColor }}>{fmtNum(pnlUsdVal as any, 4)}</td>
                      <td style={{ textAlign: 'right', color: pnlLevColor }}>{pnlLevStr}</td>
                      <td style={{ textAlign: 'right', color: pnlPctColor }}>{pnlPctStr}</td>
                      <td style={{ textAlign: 'right' }}>
                        {Number.isFinite(slLev as any) ? (
                          <span style={{ color: '#dc2626' }}>{fmtPct(slLev as any, 2)}</span>
                        ) : '-' }
                        {' '}
                        {Number.isFinite(tpLev as any) ? (
                          <span style={{ color: '#16a34a' }}>· {fmtPct(tpLev as any, 2)}</span>
                        ) : ''}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.leverage, 0)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span>{p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : '-'}</span>
                          <button
                            className="btn"
                            onClick={() => flattenOne(p.symbol, p.positionSide)}
                            title="Flatten position"
                            style={{ background: '#0d3a3a', border: '1px solid #106b6b', color: '#fff', padding: '0 6px', fontSize: 11 }}
                          >
                            Flatten
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 10 }} />
      {/* Waiting orders section */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Waiting Orders</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, opacity: .8 }}>{waiting.length}</span>
          </div>
        </div>
        {waiting.length === 0 ? (
          <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No waiting orders</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>ID</th>
                  <th style={{ textAlign: 'left' }}>Symbol</th>
                  <th style={{ textAlign: 'left' }}>Side</th>
                  <th style={{ textAlign: 'left' }}>Pos</th>
                  <th style={{ textAlign: 'left' }}>Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Invested $</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Stop</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Δ%</th>
                  <th style={{ textAlign: 'left' }}>TIF</th>
                  <th style={{ textAlign: 'left' }}>Flags</th>
                  <th style={{ textAlign: 'left' }}>Actions</th>
                  <th style={{ textAlign: 'left' }}>Error</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                  <th style={{ textAlign: 'left' }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {stableWaiting.map((w) => (
                  <tr key={w.symbol}>
                    <td>-</td>
                    <td>{w.symbol}</td>
                    <td>{(() => {
                      const ps = String(w.positionSide || '').toUpperCase()
                      if (ps === 'SHORT') return 'BUY'
                      if (ps === 'LONG') return 'SELL'
                      return '-'
                    })()}</td>
                    <td>{(() => { const ps = String(w.positionSide||''); if (!ps) return '-'; const col = ps==='LONG'?'#16a34a': ps==='SHORT'?'#dc2626': undefined; return <span style={{ color: col }}>{ps}</span> })()}</td>
                    <td>{'TAKE_PROFIT'}</td>
                    <td style={{ textAlign: 'right' }}>{w.qtyPlanned ?? '-'}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      const sym = String(w.symbol || '')
                      const amt = Number(lastAmountBySymbol[sym])
                      return (Number.isFinite(amt) && amt > 0) ? fmtNum(amt, 2) : '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      const sym = String(w.symbol || '')
                      const lev = Number(lastLeverageBySymbol[sym])
                      return Number.isFinite(lev) && lev > 0 ? fmtNum(lev, 0) : '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>-</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(Number(w.tp), 6)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(marks[w.symbol] as any, 6)}</td>
                    <td style={{ textAlign: 'right' }}>-</td>
                    <td>{'GTC'}</td>
                    <td>{'reduceOnly'}</td>
                    <td>-</td>
                    <td>{w.lastError ? (<span style={{ color: '#dc2626' }} title={w.lastErrorAt ? new Date(w.lastErrorAt).toLocaleTimeString() : undefined}>{w.lastError}</span>) : '-'}</td>
                    <td>{w.lastCheck ? new Date(w.lastCheck).toLocaleTimeString() : '-'}</td>
                    <td>{(() => { const min = ageMinutes(w.since || null); const color = colorForAge(min); return <span style={{ color }}>{fmtAge(min)}</span> })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 10 }} />
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Open Orders</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn" onClick={cancelAllOpenOrders} style={{ background: '#3a0d0d', border: '1px solid #6b1010', color: '#fff', padding: '2px 8px', fontSize: 12 }}>Close All</button>
            <span style={{ fontSize: 12, opacity: .8 }}>{orders.length}</span>
          </div>
        </div>
        {orders.length === 0 ? (
          <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No open orders</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>ID</th>
                  <th style={{ textAlign: 'left' }}>Symbol</th>
                  <th style={{ textAlign: 'left' }}>Side</th>
                  <th style={{ textAlign: 'left' }}>Pos</th>
                  <th style={{ textAlign: 'left' }}>Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Invested $</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Stop</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Δ%</th>
                  <th style={{ textAlign: 'left' }}>TIF</th>
                  <th style={{ textAlign: 'left' }}>Flags</th>
                  <th style={{ textAlign: 'left' }}>Actions</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                  <th style={{ textAlign: 'left' }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {stableOrders.map((o) => (
                  <tr key={o.orderId}>
                    <td>{o.orderId}</td>
                    <td>{o.symbol}</td>
                    <td>{o.side}</td>
                    <td>{(() => { const ps = String(o.positionSide||''); if (!ps) return '-'; const col = ps==='LONG'?'#16a34a': ps==='SHORT'?'#dc2626': undefined; return <span style={{ color: col }}>{ps}</span> })()}</td>
                    <td>{o.type}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.qty, 4)}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      const isEntry = String(o.side).toUpperCase() === 'BUY' && !(o.reduceOnly || o.closePosition)
                      if (!isEntry) return '-'
                      const sym = String(o.symbol || '')
                      const amt = Number(lastAmountBySymbol[sym])
                      return (Number.isFinite(amt) && amt > 0) ? fmtNum(amt, 2) : '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      const sym = String(o.symbol || '')
                      const lev = Number(lastLeverageBySymbol[sym])
                      return Number.isFinite(lev) && lev > 0 ? fmtNum(lev, 0) : '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.price, 6)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.stopPrice, 6)}</td>
                    <td style={{ textAlign: 'right' }}>{String(o.side).toUpperCase() === 'BUY' ? fmtNum(marks[o.symbol], 6) : '-'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {String(o.side).toUpperCase() === 'BUY' && !(o.reduceOnly || o.closePosition) ? (() => {
                        const m = Number(marks[o.symbol])
                        const tgt = pickOrderTargetPrice(o)
                        if (Number.isFinite(m) && m > 0 && Number.isFinite(tgt as any) && (tgt as number) > 0) {
                          const pct = Math.abs(((tgt as number) - m) / m) * 100
                          const color = colorForDelta(pct)
                          return <span style={{ color }}>{fmtPct(pct, 2)}</span>
                        }
                        return '-'
                      })() : '-'}
                    </td>
                    <td>{o.timeInForce || '-'}</td>
                    <td>{[o.reduceOnly ? 'reduceOnly' : null, o.closePosition ? 'closePosition' : null].filter(Boolean).join(', ') || '-'}</td>
                    <td>
                      {o.orderId ? (
                        <button
                          className="btn"
                          onClick={() => cancelOne(o.symbol, o.orderId)}
                          disabled={cancellingIds.has(o.orderId)}
                          title="Cancel order"
                          style={{ background: '#3a0d0d', border: '1px solid #6b1010', color: '#fff', padding: '0 6px', fontSize: 11 }}
                        >
                          {cancellingIds.has(o.orderId) ? '…' : 'Cancel'}
                        </button>
                      ) : '-'}
                    </td>
                    <td>{o.updatedAt ? new Date(o.updatedAt).toLocaleTimeString() : '-'}</td>
                    <td>{(() => { const min = ageMinutes(o.createdAt || null); const color = colorForAge(min); return <span style={{ color }}>{fmtAge(min)}</span> })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default OrdersPanel


