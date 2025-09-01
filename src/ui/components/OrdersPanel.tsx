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
  updatedAt: string | null
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const [marks, setMarks] = useState<Record<string, number>>({})

  const fetchJson = async (input: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ ok: boolean; status: number; json: any | null }> => {
    const ac = new AbortController()
    const timeout = window.setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), init?.timeoutMs ?? 12000)
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
    setLoading(true)
    setError(null)
    try {
      const [ord, pos] = await Promise.all([
        fetchJson('/api/open_orders'),
        fetchJson('/api/positions')
      ])
      // Handle errors explicitly – no fallbacks
      if (!ord.ok) {
        const code = ord.status === 401 && ord.json?.error === 'missing_binance_keys' ? 'missing_binance_keys' : (ord.json?.error || `HTTP ${ord.status}`)
        throw new Error(`open_orders:${code}`)
      }
      if (!pos.ok) {
        const code = pos.status === 401 && pos.json?.error === 'missing_binance_keys' ? 'missing_binance_keys' : (pos.json?.error || `HTTP ${pos.status}`)
        throw new Error(`positions:${code}`)
      }
      const ordersArr: OpenOrderUI[] = Array.isArray(ord.json?.orders) ? ord.json.orders : []
      const positionsArr: PositionUI[] = Array.isArray(pos.json?.positions) ? pos.json.positions : []
      setOrders(ordersArr)
      setPositions(positionsArr)
      // Refresh marks for BUY orders only (to gauge distance)
      await refreshMarksForOrders(ordersArr)
      setLastRefresh(new Date().toISOString())
    } catch (e: any) {
      setError(String(e?.message || 'unknown_error'))
    } finally {
      setLoading(false)
    }
  }

  const refreshMarksForOrders = async (oList: OpenOrderUI[]) => {
    try {
      const buySymbols = Array.from(new Set(
        (Array.isArray(oList) ? oList : [])
          .filter(o => String(o?.side || '').toUpperCase() === 'BUY')
          .map(o => String(o?.symbol || ''))
          .filter(Boolean)
      ))
      if (buySymbols.length === 0) return
      const res = await Promise.all(buySymbols.map(sym => fetchJson(`/api/mark?symbol=${encodeURIComponent(sym)}`)))
      const next: Record<string, number> = { ...marks }
      for (let i = 0; i < buySymbols.length; i++) {
        const r = res[i]
        if (r && r.ok) {
          const m = Number(r.json?.mark)
          if (Number.isFinite(m) && m > 0) next[buySymbols[i]] = m
        }
      }
      setMarks(next)
    } catch {}
  }

  useEffect(() => {
    let mounted = true
    ;(async () => { if (mounted) await load() })()
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
      try {
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(mark) && size > 0) {
          const sign = side === 'SHORT' ? -1 : 1
          pnlPct = sign * ((mark / entry) - 1) * 100
        }
      } catch {}
      let pnlPctLev: number | null = null
      try {
        if (Number.isFinite(pnlPct as any) && Number.isFinite(lev) && lev > 0) {
          pnlPctLev = (pnlPct as number) * lev
        }
      } catch {}
      // Static closure thresholds (informative): derive from open orders for this symbol
      let slLevPct: number | null = null
      let tpLevPct: number | null = null
      try {
        if (Number.isFinite(entry) && entry > 0 && Array.isArray(orders)) {
          const symOrders = orders.filter(o => o.symbol === p.symbol && (o.closePosition || o.reduceOnly))
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
      return { ...p, pnlPct, pnlPctLev, slLevPct, tpLevPct }
    })
  }, [positions, orders])

  return (
    <div className="card" style={{ marginTop: 12, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>Open Positions & Orders (Futures)</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, opacity: .8 }}>Auto refresh: {Math.round(POLL_MS/1000)}s</span>
          <button className="btn" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          {lastRefresh ? (<span style={{ fontSize: 12, opacity: .7 }}>Last: {new Date(lastRefresh).toLocaleTimeString()}</span>) : null}
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
          <span style={{ fontSize: 12, opacity: .8 }}>{positions.length}</span>
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
                  <th style={{ textAlign: 'right' }}>uPnL</th>
                  <th style={{ textAlign: 'right' }}>%</th>
                  <th style={{ textAlign: 'right' }}>Lev %</th>
                  <th style={{ textAlign: 'right' }}>Close Lev %</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {positionsView.map((p, idx) => {
                  const pnlPctStr = fmtPct(p.pnlPct, 2)
                  const pnlColor = Number(p.pnlPct) > 0 ? '#16a34a' : Number(p.pnlPct) < 0 ? '#dc2626' : undefined
                  const pnlLevStr = fmtPct((p as any).pnlPctLev, 2)
                  const pnlLevColor = Number((p as any).pnlPctLev) > 0 ? '#16a34a' : Number((p as any).pnlPctLev) < 0 ? '#dc2626' : undefined
                  const slLev = (p as any).slLevPct as number | null
                  const tpLev = (p as any).tpLevPct as number | null
                  return (
                    <tr key={`${p.symbol}-${idx}`}>
                      <td>{p.symbol}</td>
                      <td>{p.positionSide}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.size, 4)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.entryPrice, 6)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.markPrice, 6)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtNum(p.unrealizedPnl, 4)}</td>
                      <td style={{ textAlign: 'right', color: pnlColor }}>{pnlPctStr}</td>
                      <td style={{ textAlign: 'right', color: pnlLevColor }}>{pnlLevStr}</td>
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
                      <td>{p.updatedAt ? new Date(p.updatedAt).toLocaleTimeString() : '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 10 }} />
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Open Orders</strong>
          <span style={{ fontSize: 12, opacity: .8 }}>{orders.length}</span>
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
                  <th style={{ textAlign: 'left' }}>Type</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Stop</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Δ%</th>
                  <th style={{ textAlign: 'left' }}>TIF</th>
                  <th style={{ textAlign: 'left' }}>Flags</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, idx) => (
                  <tr key={`${o.orderId}-${idx}`}>
                    <td>{o.orderId}</td>
                    <td>{o.symbol}</td>
                    <td>{o.side}</td>
                    <td>{o.type}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.qty, 4)}</td>
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
                    <td>{o.updatedAt ? new Date(o.updatedAt).toLocaleTimeString() : '-'}</td>
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


