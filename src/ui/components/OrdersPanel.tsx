import React, { useEffect, useMemo, useRef, useState } from 'react'
import { StrategyUpdateStatus } from './StrategyUpdateStatus'
import { StrategyUpdaterControl } from './StrategyUpdaterControl'
import WatcherControl from './WatcherControl'
import WatcherStatus from './WatcherStatus'
import TopUpExecutorStatus from './TopUpExecutorStatus'
import EntryUpdaterControl from './EntryUpdaterControl'
import EntryUpdaterStatus from './EntryUpdaterStatus'
import AIProfitTakerControl from './AIProfitTakerControl'
import { getSoundEnabled, setSoundEnabled, playPriceAlertSound, playPositionOpenSound } from '../utils/sounds'
import { TradingViewChart } from './TradingViewChart'
import { PositionChartWithHealth } from './PositionChartWithHealth'

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
  clientOrderId?: string | null
  isExternal?: boolean
  isStrategyUpdater?: boolean  // CRITICAL: Flag for orders created by Strategy Updater
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
  isExternal?: boolean
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
  const [sectionUpdated, setSectionUpdated] = useState<{ positions?: string|null; orders?: string|null; marks?: string|null; server_time?: string|null }>({})
  const [binanceUsage, setBinanceUsage] = useState<{ weight1m_used?: number|null; weight1m_limit?: number|null; percent?: number|null; risk?: string; backoff_active?: boolean; backoff_remaining_sec?: number|null } | null>(null)
  const [lastAmountBySymbol, setLastAmountBySymbol] = useState<Record<string, number>>({})
  const [lastLeverageBySymbol, setLastLeverageBySymbol] = useState<Record<string, number>>({})
  const [lastStrategyBySymbol, setLastStrategyBySymbol] = useState<Record<string, 'aggressive' | 'conservative'>>({})
  const [lastPlannedSLBySymbol, setLastPlannedSLBySymbol] = useState<Record<string, number>>({})
  const [lastPlannedTPBySymbol, setLastPlannedTPBySymbol] = useState<Record<string, number>>({})
  const [lastRiskLabelBySymbol, setLastRiskLabelBySymbol] = useState<Record<string, string>>({})
  const [cancellingIds, setCancellingIds] = useState<Set<number>>(new Set())
  const [backoffUntilMs, setBackoffUntilMs] = useState<number | null>(null)
  // no warmup mode – respecting single consolidated poll only
  const [pendingCancelAgeMin, setPendingCancelAgeMin] = useState<number>(() => {
    try { const v = localStorage.getItem('pending_cancel_age_min'); const n = v == null ? 0 : Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0 } catch { return 0 }
  })
  // Trading Charts toggle
  const [showAllCharts, setShowAllCharts] = useState<boolean>(false)
  const [visibleChartsCount, setVisibleChartsCount] = useState<number>(0)
  const [strategyUpdaterEntries, setStrategyUpdaterEntries] = useState<any[]>([])
  const [strategyUpdaterEnabled, setStrategyUpdaterEnabled] = useState<boolean>(false)
  // Profit Taker removed – replaced by Top-Up Executor
  const [watcherEntries, setWatcherEntries] = useState<any[]>([])
  const [watcherEnabled, setWatcherEnabled] = useState<boolean>(true)
  const [topUpExecutorEntries, setTopUpExecutorEntries] = useState<any[]>([])
  const [topUpExecutorEnabled, setTopUpExecutorEnabled] = useState<boolean>(true)
  const [entryUpdaterEntries, setEntryUpdaterEntries] = useState<any[]>([])
  const [entryUpdaterEnabled, setEntryUpdaterEnabled] = useState<boolean>(false)
  // AI Profit Taker - manual tool, track last run timestamp
  const [aiProfitTakerLastRun, setAiProfitTakerLastRun] = useState<string | null>(null)
  // Map symbol -> last planned entry price from last_place.request.orders
  const [lastEntryBySymbol, setLastEntryBySymbol] = useState<Record<string, number>>({})
  const [euLastBySymbol, setEuLastBySymbol] = useState<Record<string, { phase?: string; reason_code?: string }>>({})
  const [temporalWorkerInfo, setTemporalWorkerInfo] = useState<any>(null)
  // Health Monitor
  const [healthMonitorEntries, setHealthMonitorEntries] = useState<any[]>([])
  const [healthMonitorEnabled, setHealthMonitorEnabled] = useState<boolean>(true)
  const [healthSyncLoading, setHealthSyncLoading] = useState(false)
  const [healthSyncFeedback, setHealthSyncFeedback] = useState<string | null>(null)
  
  // Sound controls state
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => getSoundEnabled())
  
  const handleToggleSound = () => {
    const newValue = !soundEnabled
    setSoundEnabledState(newValue)
    setSoundEnabled(newValue)
  }

  // Manual Health Monitor Sync
  const syncHealthMonitor = async () => {
    if (healthSyncLoading) return
    setHealthSyncLoading(true)
    setHealthSyncFeedback(null)
    try {
      const res = await fetchJson('/api/health_monitor_sync', { method: 'POST', timeoutMs: 30000 })
      if (res.ok) {
        // Update health monitor entries immediately
        const status = res.json?.status
        if (status && Array.isArray(status.entries)) {
          setHealthMonitorEntries(status.entries)
          setHealthMonitorEnabled(Boolean(status.enabled))
          
          // Count positions vs pending orders
          const positions = status.entries.filter((e: any) => e.type === 'position')
          const pendingOrders = status.entries.filter((e: any) => e.type === 'pending_order')
          
          // Show detailed feedback
          const feedback = `✓ Sync OK: ${positions.length} pozic${positions.length === 1 ? 'e' : 'í'}, ${pendingOrders.length} SELL entry order${pendingOrders.length === 1 ? '' : 's'}`
          setHealthSyncFeedback(feedback)
          
          console.info('[HEALTH_SYNC_MANUAL]', { 
            success: true, 
            positions: positions.length,
            pendingOrders: pendingOrders.length,
            total: status.entries.length 
          })
          
          // Clear feedback after 5 seconds
          setTimeout(() => setHealthSyncFeedback(null), 5000)
        }
      } else {
        throw new Error(res.json?.error || `HTTP ${res.status}`)
      }
    } catch (e: any) {
      console.error('[HEALTH_SYNC_MANUAL_ERR]', e?.message || e)
      const errorMsg = `✗ Sync error: ${e?.message || 'unknown'}`
      setHealthSyncFeedback(errorMsg)
      setTimeout(() => setHealthSyncFeedback(null), 5000)
    } finally {
      setHealthSyncLoading(false)
    }
  }

  // Cancel Delta % state
  const [cancelDelta, setCancelDelta] = useState(3.5)
  const [deltaLoading, setDeltaLoading] = useState(false)
  const [deltaFeedback, setDeltaFeedback] = useState<string|null>(null)

  // Source of truth is the server – sync on mount
  const syncPendingCancelFromServer = async (): Promise<void> => {
    try {
      const r = await fetchJson('/api/trading/settings', { timeoutMs: 600000 })
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
    const tm = init?.timeoutMs ?? 600000
    const timeout = window.setTimeout(() => {
      try { ac.abort(new DOMException(`timeout after ${tm}ms`, 'TimeoutError')) } catch { ac.abort() }
    }, tm)
    try {
      const baseHeaders: Record<string,string> = { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
      const mergedHeaders = { ...(init?.headers || {} as any), ...baseHeaders }
      const res = await fetch(input, { ...(init || {}), signal: ac.signal, cache: 'no-store', headers: mergedHeaders })
      const status = res.status
      let json: any = null
      try { json = await res.json() } catch {}
      return { ok: res.ok, status, json }
    } finally {
      clearTimeout(timeout)
    }
  }

  const load = async (forceNow: boolean = false) => {
    if (loading) return
    if (!forceNow && Number.isFinite(backoffUntilMs as any) && (backoffUntilMs as number) > Date.now()) {
      // During Binance ban window: skip hitting API
      setLastRefresh(new Date().toISOString())
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Cache-buster param to avoid any intermediary caching layers from serving stale responses
      const force = (forceNow ? '&force=1' : '')
      const cons = await fetchJson(`/api/orders_console?ts=${Date.now()}${force}`, { timeoutMs: 600000 })
      if (!cons.ok) {
        const code = cons.status === 401 && cons.json?.error === 'missing_binance_keys' ? 'missing_binance_keys' : (cons.json?.error || `HTTP ${cons.status}`)
        // Don't clear existing positions on rate limit errors - keep showing last data
        if (code !== 'rate_limited') {
          setOrders([]); setWaiting([]); setPositions([])
        }
        // Try to preserve binance usage badge if server provided it even on error
        try {
          const bu = (cons.json?.binance_usage && typeof cons.json.binance_usage === 'object') ? cons.json.binance_usage : null
          if (bu) setBinanceUsage(bu)
        } catch {}
        setLastRefresh(new Date().toISOString())
        setLoading(false)
        // Show rate limit errors, ignore others
        if (code === 'missing_binance_keys' || code === 'rate_limited') throw new Error(`orders_console:${code}`)
        return
      }
      const json = cons.json || {}
      const ordersArr: OpenOrderUI[] = Array.isArray(json?.open_orders) ? json.open_orders : []
      const waitingArr: WaitingOrderUI[] = Array.isArray(json?.waiting) ? json.waiting : []
      const positionsArr: PositionUI[] = Array.isArray(json?.positions) ? json.positions : []
      const marksObj: Record<string, number> = (json?.marks && typeof json.marks === 'object') ? json.marks : {}
      const upd = (json?.updated_at && typeof json.updated_at === 'object') ? json.updated_at : {}
      setSectionUpdated({ positions: upd.positions ?? null, orders: upd.orders ?? null, marks: upd.marks ?? null, server_time: json?.server_time ?? null })
      try {
        const bu = (json?.binance_usage && typeof json.binance_usage === 'object') ? json.binance_usage : null
        setBinanceUsage(bu)
      } catch {}
      // Capture last planned entry prices for Δ% fallback (even if entry order is not open)
      try {
        const lp = Array.isArray(json?.last_place?.request?.orders) ? json.last_place.request.orders : []
        const mapEntry: Record<string, number> = {}
        const mapStrat: Record<string, 'aggressive' | 'conservative'> = {}
        const mapRisk: Record<string, string> = {}
        for (const o of lp) {
          const sym = String((o as any)?.symbol || '')
          const e = Number((o as any)?.entry)
          const stratRaw = String((o as any)?.strategy || '')
          const strat = stratRaw === 'aggressive' ? 'aggressive' : (stratRaw === 'conservative' ? 'conservative' : null)
          const riskLbl = (() => { try { return String((o as any)?.risk_label || '') } catch { return '' } })()
          if (sym && Number.isFinite(e) && e > 0) mapEntry[sym] = e
          if (sym && strat) mapStrat[sym] = strat
          if (sym && riskLbl) mapRisk[sym] = riskLbl
        }
        setLastEntryBySymbol(mapEntry)
        setLastStrategyBySymbol(mapStrat)
        setLastRiskLabelBySymbol(mapRisk)
      } catch {}
      // Sort orders by createdAt asc for stable Age
      try {
        ordersArr.sort((a, b) => {
          const ta = a.createdAt ? Date.parse(a.createdAt) : 0
          const tb = b.createdAt ? Date.parse(b.createdAt) : 0
          if (ta !== tb) return ta - tb
          return Number(a.orderId) - Number(b.orderId)
        })
      } catch {}
      setOrders(ordersArr)
      setWaiting(waitingArr)
      setPositions(positionsArr)
      // Build symbol -> amount map (pouze server aux.last_planned_by_symbol – bez fallbacků)
      try {
        const mapAmt: Record<string, number> = {}
        const mapLev: Record<string, number> = {}
        const mapSL: Record<string, number> = {}
        const mapTP: Record<string, number> = {}
        const aux = (json?.aux && typeof json.aux === 'object') ? json.aux : {}
        const planned = (aux?.last_planned_by_symbol && typeof aux.last_planned_by_symbol === 'object') ? aux.last_planned_by_symbol : {}
        for (const k of Object.keys(planned)) {
          const sym = String(k)
          const v = (planned as any)[k] || {}
          const amt = Number(v?.amount)
          const lev = Number(v?.leverage)
          const sl = Number(v?.sl)
          const tp = Number(v?.tp)
          if (sym && Number.isFinite(amt) && amt > 0) mapAmt[sym] = amt
          if (sym && Number.isFinite(lev) && lev > 0) mapLev[sym] = Math.floor(lev)
          if (sym && Number.isFinite(sl) && sl > 0) mapSL[sym] = sl
          if (sym && Number.isFinite(tp) && tp > 0) mapTP[sym] = tp
        }
        // Merge leverage_by_symbol from server (authoritative from positions), but do not overwrite explicit planned leverage if present
        try {
          const levSrv = (aux?.leverage_by_symbol && typeof aux.leverage_by_symbol === 'object') ? aux.leverage_by_symbol : {}
          for (const k of Object.keys(levSrv)) {
            const lev = Number((levSrv as any)[k])
            if (!Number.isFinite(lev) || lev <= 0) continue
            if (!(k in mapLev)) mapLev[k] = Math.floor(lev)
          }
        } catch {}
        setLastAmountBySymbol(mapAmt)
        setLastLeverageBySymbol(mapLev)
        setLastPlannedSLBySymbol(mapSL)
        setLastPlannedTPBySymbol(mapTP)
      } catch {}
      // Handshake: if server indicates auto-cancel happened, disable locally and on server
      try {
        if (json && json.auto_cancelled_due_to_age) {
          localStorage.removeItem('pending_cancel_age_min')
          setPendingCancelAgeMin(0)
          await fetchJson('/api/trading/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending_cancel_age_min: 0 }), timeoutMs: 600000 })
        }
      } catch {}
      // Update marks from WS snapshot (no per-symbol REST calls)
      try { if (marksObj && typeof marksObj === 'object') setMarks(marksObj) } catch {}
      // After successful sync, purge any localStorage remnants that could block fresh trades
      try {
        const staleKeys = ['orders_console','open_orders','positions','waiting_tp']
        staleKeys.forEach(k=>{ try { localStorage.removeItem(k) } catch {} })
      } catch {}
      setLastRefresh(new Date().toISOString())
      // Successful fetch clears any previous backoff window
      setBackoffUntilMs(null)
      
      // Load strategy updater status (single consolidated call; pass entries to row component)
      fetchJson('/api/strategy_updater_status', { timeoutMs: 60000 })
        .then(r => {
          if (r.ok) {
            const en = Boolean(r.json?.enabled)
            const arr = Array.isArray(r.json?.entries) ? r.json.entries : []
            setStrategyUpdaterEnabled(en)
            setStrategyUpdaterEntries(arr)
          }
        })
        .catch(() => { /* ignore */ })
      // Profit Taker disabled (replaced by Top-Up Executor) – no fetch
      // Load top-up watcher status
      fetchJson('/api/topup_watcher_status', { timeoutMs: 60000 })
        .then(r => {
          if (r.ok) {
            const en = Boolean(r.json?.enabled)
            const arr = Array.isArray(r.json?.entries) ? r.json.entries : []
            setWatcherEnabled(en)
            setWatcherEntries(arr)
          }
        })
        .catch(() => { /* ignore */ })
      // Load top-up executor status
      fetchJson('/api/top_up_executor_status', { timeoutMs: 60000 })
        .then(r => {
          if (r.ok) {
            const en = Boolean(r.json?.enabled)
            const arr = Array.isArray(r.json?.entries) ? r.json.entries : []
            setTopUpExecutorEnabled(en)
            setTopUpExecutorEntries(arr)
          }
        })
        .catch(() => { /* ignore */ })

      // Load entry updater status (UX stejné jako Strategy Updater)
      fetchJson('/api/entry_updater_status', { timeoutMs: 60000 })
        .then(r => {
          if (r.ok) {
            const en = Boolean(r.json?.enabled)
            const arr = Array.isArray(r.json?.entries) ? r.json.entries : []
            setEntryUpdaterEnabled(en)
            setEntryUpdaterEntries(arr)
            // Fetch latest audit per involved symbol so we can show last action (no_op/reposition/cancel)
            try {
              const syms = Array.from(new Set((arr || []).map((e:any)=> String(e?.symbol||'')).filter(Boolean)))
              syms.slice(0, 10).forEach(async (s) => {
                try {
                  const res = await fetchJson(`/api/entry_updater_audit/latest?symbol=${encodeURIComponent(s)}`, { timeoutMs: 20000 })
                  if (res.ok && res.json && typeof res.json === 'object') {
                    const entry = (res.json as any)?.entry || null
                    setEuLastBySymbol(prev => ({ ...prev, [s]: { phase: String(entry?.phase||'') || undefined, reason_code: String(entry?.reason_code||'') || undefined } }))
                  }
                } catch {}
              })
            } catch {}
          }
        })
        .catch(() => { /* ignore */ })
      
      // Load health monitor status
      fetchJson('/api/health_monitor_status', { timeoutMs: 60000 })
        .then(r => {
          if (r.ok) {
            const en = Boolean(r.json?.enabled)
            const arr = Array.isArray(r.json?.entries) ? r.json.entries : []
            setHealthMonitorEnabled(en)
            setHealthMonitorEntries(arr)
          }
        })
        .catch(() => { /* ignore */ })
      
      // Load Temporal worker info (100% reliable, no cache)
      fetchJson('/api/temporal/worker/info', { timeoutMs: 10000 })
        .then(r => {
          if (r.ok && r.json) {
            setTemporalWorkerInfo(r.json)
          }
        })
        .catch(() => { /* ignore */ })
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
      // Only internal orders are eligible for bulk-cancel
      const ids = orders
        .filter(o => !o.isExternal)
        .map(o => ({ symbol: o.symbol, id: o.orderId }))
        .filter(x => x.id)
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
      const isEntry = isEntryOrderUI(o)
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

  const strategyFromOrdersBySymbol = useMemo(() => {
    const map: Record<string, 'aggressive' | 'conservative'> = {}
    try {
      for (const o of (orders || [])) {
        const sym = String(o?.symbol || '')
        if (!sym) continue
        const isEntry = isEntryOrderUI(o)
        if (!isEntry) continue
        const t = String(o?.type || '').toUpperCase()
        const isStopType = t.includes('STOP')
        const isLimit = t === 'LIMIT'
        if (isStopType) map[sym] = 'aggressive'
        else if (isLimit && !map[sym]) map[sym] = 'conservative'
      }
    } catch {}
    return map
  }, [orders])

  const missingSlBySymbol = useMemo(() => {
    const set = new Set<string>()
    try {
      // Pokud je SL vypnut v configu, nehlásit chybějící SL
      try {
        // dynamic import to access build-time config json
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cfg = require('../../../config/trading.json') as any
        if (cfg && cfg.DISABLE_SL === true) return new Set<string>()
      } catch {}
      const bySym: Record<string, { hasEntry: boolean; hasSl: boolean }> = {}
      for (const o of (orders || [])) {
        const sym = String(o?.symbol || '')
        if (!sym) continue
        const type = String(o?.type || '').toUpperCase()
        const cp = Boolean(o?.closePosition)
        const reduceOnly = Boolean(o?.reduceOnly)
        const isEntry = isEntryOrderUI(o)
        // Any STOP_MARKET with closePosition=true is considered SL (for both LONG/SHORT)
        const isSl = type === 'STOP_MARKET' && cp === true
        if (!bySym[sym]) bySym[sym] = { hasEntry: false, hasSl: false }
        if (isEntry) bySym[sym].hasEntry = true
        if (isSl) bySym[sym].hasSl = true
      }
      for (const [sym, v] of Object.entries(bySym)) {
        if (v.hasEntry && !v.hasSl) set.add(sym)
      }
    } catch {}
    return set
  }, [orders])

  const isExternalOrder = (o: OpenOrderUI): boolean => Boolean((o as any)?.isExternal === true)
  
  const isStrategyUpdaterOrder = (o: OpenOrderUI): boolean => {
    try {
      // Authoritative server flag only – no client-side heuristics
      return (o as any)?.isStrategyUpdater === true
    } catch { return false }
  }

  // Entry Updater: highlight ENTRY orders that were repositioned by Entry Updater (clientOrderId prefix "eu_")
  const isEntryUpdaterOrder = (o: OpenOrderUI): boolean => {
    try {
      const clientId = String(o?.clientOrderId || '')
      if (!/^sv2_eu_/.test(clientId)) return false
      const sideSell = String(o?.side || '').toUpperCase() === 'SELL'
      const isEntry = sideSell && !(o?.reduceOnly || o?.closePosition)
      return isEntry
    } catch { return false }
  }

  // AI Profit Taker: highlight SL/TP orders created by AI Profit Taker (clientOrderId prefix "ai_pt_")
  const isAIProfitTakerOrder = (o: OpenOrderUI): boolean => {
    try {
      const clientId = String(o?.clientOrderId || '')
      return /^ai_pt_(sl|tp)_/.test(clientId)
    } catch { return false }
  }

  const stableWaiting = useMemo(() => {
    const list = Array.isArray(waiting) ? [...waiting] : []
    list.sort((a, b) => a.symbol.localeCompare(b.symbol))
    return list
  }, [waiting])

  // Map symbol -> position snapshot (for leverage/entry/size)
  const posBySymbol = useMemo(() => {
    const map: Record<string, { entry?: number|null; lev?: number|null; size?: number|null }> = {}
    try {
      for (const p of (positions || [])) {
        const sym = String(p?.symbol || '')
        if (!sym) continue
        map[sym] = { entry: Number(p.entryPrice), lev: Number(p.leverage), size: Number(p.size) }
      }
    } catch {}
    return map
  }, [positions])

  const flattenOne = async (symbol: string, side: string | null | undefined) => {
    try {
      console.log('[FLATTEN_ONE_START]', { symbol, side, sideType: typeof side })
      
      // Fallback to 'SHORT' for SHORT-only system
      const s = side ? String(side).toUpperCase() : 'SHORT'
      console.log('[FLATTEN_ONE_SENDING]', { symbol, side: s, url: `/__proxy/binance/flatten?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(s)}` })
      
      const r = await fetch(`/__proxy/binance/flatten?symbol=${encodeURIComponent(symbol)}&side=${encodeURIComponent(s)}`, { method: 'POST' })
      console.log('[FLATTEN_ONE_RESPONSE]', { symbol, ok: r.ok, status: r.status })
      
      if (!r.ok) {
        const t = await r.text().catch(()=> '')
        console.error('[FLATTEN_ONE_ERROR_RESPONSE]', { symbol, status: r.status, text: t })
        throw new Error(t || `HTTP ${r.status}`)
      }
      
      const result = await r.json().catch(() => ({}))
      console.log('[FLATTEN_ONE_SUCCESS]', { symbol, result })
      
      await load()
    } catch (e:any) {
      console.error('[FLATTEN_ONE_EXCEPTION]', { symbol, error: e?.message, stack: e?.stack })
      setError(`flatten_failed:${symbol}:${e?.message || 'unknown'}`)
    }
  }

  const flattenAllPositions = async () => {
    try {
      if (!positions || positions.length === 0) return
      const ok = window.confirm(`Flatten ALL ${positions.length} positions?`)
      if (!ok) return
      await Promise.allSettled(
        positions.map(p => fetch(`/__proxy/binance/flatten?symbol=${encodeURIComponent(p.symbol)}&side=${encodeURIComponent(String(p.positionSide||'SHORT'))}`, { method: 'POST' }))
      )
      await load()
    } catch (e:any) {
      setError(`flatten_all_failed:${e?.message || 'unknown'}`)
    }
  }

  useEffect(() => {
    let mounted = true
    // Proaktivní vyčištění lokálního úložiště pro banner – prevence zobrazení starých dat
    try {
      const keys = ['orders_console', 'open_orders', 'positions', 'waiting_tp']
      for (const k of keys) { try { localStorage.removeItem(k) } catch {} }
    } catch {}
    // Warmup odstraněn – striktně jedno konsolidované volání bez dodatečných dotazů
    ;(async () => { if (mounted) { await syncPendingCancelFromServer(); await load(false) } })()
    timerRef.current = window.setInterval(() => load(false), POLL_MS)
    return () => {
      mounted = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Removed visibilitychange instant refresh to enforce exactly one poll every POLL_MS
  useEffect(() => { /* single interval only – no visibility-based refresh */ }, [])

  // Load Cancel Delta % from server config on mount
  useEffect(() => {
    fetch('/api/config/trading')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        // STRICT: Načti ze správné struktury { ok: true, config: {...} }
        if (data?.ok && data?.config?.ENTRY_DELTA_CANCEL_PCT !== undefined) {
          const val = Number(data.config.ENTRY_DELTA_CANCEL_PCT)
          if (Number.isFinite(val)) {
            setCancelDelta(val)
            console.log('[DELTA_LOADED]', val)
          }
        } else {
          console.warn('[DELTA_LOAD_FAILED] Invalid API response:', data)
        }
      })
      .catch((e) => {
        console.error('[DELTA_LOAD_ERROR]', e)
      })
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

  // Robust detection: ENTRY orders are any non-exit orders (no reduceOnly/closePosition)
  // of types LIMIT/STOP/STOP_MARKET/MARKET regardless of side (BUY for LONG, SELL for SHORT)
  const isEntryOrderUI = (o: OpenOrderUI): boolean => {
    try {
      const typeUp = String(o.type || '').toUpperCase()
      const isEntryType = (typeUp === 'LIMIT' || typeUp === 'STOP' || typeUp === 'STOP_MARKET' || typeUp === 'MARKET')
      const exitFlag = Boolean(o.reduceOnly) || Boolean(o.closePosition)
      return isEntryType && !exitFlag
    } catch { return false }
  }

  const onChangePendingCancel = async (val: number) => {
    try {
      const prev = pendingCancelAgeMin
      setPendingCancelAgeMin(val)
      const r = await fetchJson('/api/trading/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending_cancel_age_min: val }), timeoutMs: 600000 })
      if (!r.ok) { throw new Error(String((r.json as any)?.error || `HTTP ${r.status}`)) }
      try { localStorage.setItem('pending_cancel_age_min', String(val)) } catch {}
    } catch (e: any) {
      setError(`pending_cancel_save_failed:${e?.message || 'unknown'}`)
      // Revert UI to previous value on failure to avoid mismatch
      try {
        const srv = await fetchJson('/api/trading/settings', { timeoutMs: 600000 })
        const v = srv.ok ? Number((srv.json as any)?.pending_cancel_age_min) : NaN
        if (Number.isFinite(v)) {
          setPendingCancelAgeMin(Math.max(0, Math.floor(v)))
        }
      } catch {}
    }
  }

  const pickOrderTargetPrice = (o: OpenOrderUI): number | null => {
    // Robust target resolution per order type so Δ% always shows for ENTRY orders
    const t = String(o.type || '').toUpperCase()
    const priceNum = Number(o.price)
    const stopNum = Number(o.stopPrice)
    const hasPrice = Number.isFinite(priceNum) && priceNum > 0
    const hasStop = Number.isFinite(stopNum) && stopNum > 0
    if (t === 'LIMIT') {
      if (hasPrice) return priceNum
      if (hasStop) return stopNum
      return null
    }
    if (t === 'STOP' || t === 'STOP_MARKET') {
      if (hasStop) return stopNum
      if (hasPrice) return priceNum
      return null
    }
    // Default: prefer stop, then price
    if (hasStop) return stopNum
    if (hasPrice) return priceNum
    return null
  }

  // Memoize positions view with stable reference to prevent chart re-renders
  const positionsView = useMemo(() => {
    // Don't recalculate if positions haven't changed structurally
    return positions.map(p => {
      const entry = Number(p.entryPrice)
      // Resolve mark safely: prefer position.markPrice when valid, otherwise fallback to marks map; never coerce null to 0
      const markFromPos = (typeof p.markPrice === 'number' && Number.isFinite(p.markPrice) && p.markPrice > 0) ? p.markPrice : null
      const markFromMapNum = Number(marks[p.symbol])
      const mark = Number.isFinite(markFromPos as any)
        ? (markFromPos as number)
        : (Number.isFinite(markFromMapNum) && markFromMapNum > 0 ? markFromMapNum : NaN)
      const size = Number(p.size)
      const side = String(p.positionSide || '')
      const lev = Number(p.leverage)
      let pnlPct: number | null = null
      let pnlUsd: number | null = null
      try {
        if (Number.isFinite(entry) && entry > 0 && Number.isFinite(mark) && size > 0) {
          const sign = side === 'SHORT' ? -1 : 1
          pnlPct = sign * ((mark as number) / entry - 1) * 100
          // Absolute P&L in USDT (LONG-only use-case)
          pnlUsd = (((mark as number) - entry) * size) * (side === 'SHORT' ? -1 : 1)
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
          
          // CRITICAL FIX: Prioritize Strategy Updater orders (AI), then newest
          const slOrders = symOrders.filter(o => isSL(o.type))
          const tpOrders = symOrders.filter(o => isTP(o.type))
          
          const slOrder = slOrders.length > 0 ? slOrders.sort((a, b) => {
            const aIsAi = a.isStrategyUpdater || String(a.clientOrderId || '').includes('x_ai_sl_')
            const bIsAi = b.isStrategyUpdater || String(b.clientOrderId || '').includes('x_ai_sl_')
            if (aIsAi !== bIsAi) return aIsAi ? -1 : 1
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return bTime - aTime
          })[0] : null
          
          const tpOrder = tpOrders.length > 0 ? tpOrders.sort((a, b) => {
            const aIsAi = a.isStrategyUpdater || String(a.clientOrderId || '').includes('x_ai_tp_')
            const bIsAi = b.isStrategyUpdater || String(b.clientOrderId || '').includes('x_ai_tp_')
            if (aIsAi !== bIsAi) return aIsAi ? -1 : 1
            const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return bTime - aTime
          })[0] : null
          
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
      // Override markPrice in view with resolved value for consistent UI display
      const markForView = Number.isFinite(mark) ? (mark as number) : (typeof p.markPrice === 'number' ? p.markPrice : null)
      return { ...p, markPrice: markForView, pnlPct, pnlPctLev, pnlUsd, marginUsd, slLevPct, tpLevPct }
    })
  }, [positions, orders, marks]) // CRITICAL FIX: Must include full arrays to react to markPrice updates

  // Filter positions for charts: only SHORT (our system) positions, exclude LONG (external)
  const positionsViewForCharts = useMemo(() => {
    return positionsView.filter(p => !p.isExternal)
  }, [positionsView])

  // Track previous position count for sound trigger
  const prevPositionCountRef = useRef<number>(0)

  // Auto-open Charts when first position appears
  useEffect(() => {
    if (positionsView.length > 0 && !showAllCharts) {
      console.log('[AUTO_CHARTS] 🎯 Position detected, auto-opening charts container')
      setShowAllCharts(true)
    }
  }, [positionsView.length, showAllCharts])

  // Play sound when new position opens
  useEffect(() => {
    const currentCount = positionsView.length
    const previousCount = prevPositionCountRef.current
    
    // Trigger sound only when position count increases (new position opened)
    if (currentCount > previousCount && previousCount >= 0) {
      console.log('[POSITION_SOUND] 🔔 New position detected, playing sound', { previousCount, currentCount })
      playPositionOpenSound()
    }
    
    // Update ref for next comparison
    prevPositionCountRef.current = currentCount
  }, [positionsView.length])

  // Staggered chart loading to prevent UI freezing
  useEffect(() => {
    console.log('[CHARTS_LOADER] showAllCharts:', showAllCharts, 'positionsViewForCharts.length:', positionsViewForCharts.length)
    
    if (!showAllCharts) {
      setVisibleChartsCount(0)
      return
    }
    
    if (positionsViewForCharts.length === 0) {
      console.warn('[CHARTS_LOADER] No positions to display charts for')
      return
    }
    
    // Gradually show charts one by one with small delay
    let count = 0
    console.log('[CHARTS_LOADER] Starting staggered chart loading...')
    const interval = setInterval(() => {
      count++
      console.log('[CHARTS_LOADER] Showing chart', count, '/', positionsViewForCharts.length)
      setVisibleChartsCount(count)
      
      if (count >= positionsViewForCharts.length) {
        clearInterval(interval)
        console.log('[CHARTS_LOADER] All charts loaded')
      }
    }, 100) // 100ms delay between each chart
    
    return () => {
      console.log('[CHARTS_LOADER] Cleanup')
      clearInterval(interval)
    }
  }, [showAllCharts, positionsViewForCharts.length])

  return (
    <div className="card" style={{ marginTop: 12, padding: 12, position: 'relative' }}>
      {/* Temporal Worker Connection Badge */}
      {(() => {
        const info = temporalWorkerInfo
        if (!info) return null
        const workerCount = Number(info?.workerCount ?? 0)
        const connectedPorts = Array.isArray(info?.connectedPorts) ? info.connectedPorts : []
        const connectedForbiddenPorts = Array.isArray(info?.connectedForbiddenPorts) ? info.connectedForbiddenPorts : []
        const taskQueue = String(info?.taskQueue || '')
        const tradeSide = String(info?.tradeSide || '')
        const configuredPort = String(info?.configuredPort || '')
        
        // CRITICAL: RED if connected to forbidden ports (LONG contamination!)
        const hasForbiddenConnection = connectedForbiddenPorts.length > 0
        
        // Colors: GREEN (1 connection), RED (forbidden or duplicate), GRAY (0 disconnected)
        let bg = '#6b7280' // gray - disconnected
        if (workerCount === 1 && !hasForbiddenConnection) bg = '#16a34a' // green - single connection
        if (workerCount >= 2 || hasForbiddenConnection) bg = '#dc2626' // red - duplicate or forbidden!
        
        const portLabel = connectedPorts.length > 0 ? connectedPorts.join(' + ') : (configuredPort || 'n/a')
        const duplicateWarning = workerCount >= 2 ? ' DUPLICATE!' : ''
        const forbiddenWarning = hasForbiddenConnection ? ' ⚠️ FORBIDDEN PORT!' : ''
        const queueShort = taskQueue.replace('entry-', '')
        
        const tooltipLines = [
          'Temporal Worker',
          `Configured: ${info?.address || 'n/a'}`,
          `Namespace: ${info?.namespace || 'default'}`,
          `Queue: ${taskQueue}`,
          `Side: ${tradeSide}`,
          `Connected to: ${connectedPorts.length > 0 ? connectedPorts.join(', ') : (configuredPort || 'none')}`,
          hasForbiddenConnection ? `🚨 FORBIDDEN CONNECTION: ${connectedForbiddenPorts.join(', ')} - POSSIBLE LONG CONTAMINATION!` : '',
          workerCount === 1 && !hasForbiddenConnection ? '✅ OK - Single connection' : workerCount >= 2 ? '⚠️ DUPLICATE! Connected to multiple Temporal servers!' : '❌ No active connection'
        ].filter(Boolean)
        const title = tooltipLines.join('\n')
        
        return (
          <div title={title} style={{ position: 'fixed', top: 6, left: 6, zIndex: 9999, background: bg, color: '#fff', padding: '4px 8px', borderRadius: 6, fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.3)', fontFamily: 'monospace' }}>
            <span style={{ opacity: .9 }}>Temporal</span>
            <span style={{ marginLeft: 6, fontWeight: 700 }}>:{portLabel}</span>
            <span style={{ marginLeft: 6, opacity: .9 }}>{queueShort}</span>
            <span style={{ marginLeft: 6, fontWeight: 700 }}>{tradeSide}</span>
            {forbiddenWarning && <span style={{ marginLeft: 6, fontWeight: 900, color: '#fef08a' }}>{forbiddenWarning}</span>}
            {duplicateWarning && <span style={{ marginLeft: 6, fontWeight: 900, color: '#fef08a' }}>{duplicateWarning}</span>}
          </div>
        )
      })()}
      {/* Mini Binance usage badge – no extra requests; uses orders_console payload */}
      {(() => {
        const u = binanceUsage
        if (!u) return null
        const pct = Number(u.percent)
        const backoff = Boolean(u.backoff_active)
        // Colors: green (<60%), orange (60–85%), red (>85% or backoff)
        let bg = '#16a34a' // green
        if (backoff || (Number.isFinite(pct) && pct > 85)) bg = '#dc2626' // red
        else if (Number.isFinite(pct) && pct >= 60) bg = '#f59e0b' // orange
        const label = Number.isFinite(pct) ? `${pct}%` : 'n/a'
        const used = Number(u.weight1m_used)
        const limit = Number(u.weight1m_limit)
        const usedTxt = Number.isFinite(used) && used >= 0 ? String(used) : '—'
        const limitTxt = Number.isFinite(limit) && limit > 0 ? String(limit) : '—'
        const title = `Binance weight 1m: ${u.weight1m_used ?? '?'} / ${u.weight1m_limit ?? 1200}${backoff ? ` | backoff ${u.backoff_remaining_sec ?? ''}s` : ''}`
        return (
          <div title={title} style={{ position: 'fixed', top: 6, right: 6, zIndex: 9999, background: bg, color: '#fff', padding: '4px 8px', borderRadius: 6, fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,.3)' }}>
            <span style={{ opacity: .9 }}>Binance</span>
            <span style={{ marginLeft: 6, fontWeight: 700 }}>{label}</span>
            <span style={{ marginLeft: 6, opacity: .9 }}>{usedTxt}/{limitTxt}</span>
          </div>
        )
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong>Open Positions & Orders (Futures)</strong>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, opacity: .8 }}>
            Auto refresh: {Math.round(POLL_MS/1000)}s{(Number.isFinite(backoffUntilMs as any) && (backoffUntilMs as number) > Date.now()) ? ` (backoff ${Math.max(0, Math.ceil(((backoffUntilMs as number) - Date.now())/1000))}s)` : ''}
          </span>
          <button className="btn" onClick={() => load(true)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button 
              className="btn" 
              onClick={syncHealthMonitor} 
              disabled={healthSyncLoading}
              title="Manuální synchronizace Health Monitoru pro pozice + SELL entry orders - použij pokud se health nespustil automaticky"
              style={{ 
                background: healthSyncLoading ? '#374151' : (healthSyncFeedback?.startsWith('✓') ? '#059669' : '#065f46'), 
                border: healthSyncFeedback?.startsWith('✓') ? '2px solid #10b981' : '1px solid #10b981',
                color: '#fff',
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 600,
                transition: 'all 0.3s ease'
              }}
            >
              {healthSyncLoading ? '⏳ Syncing...' : '💚 Health Sync'}
            </button>
            {healthSyncFeedback && (
              <span 
                style={{ 
                  fontSize: 11, 
                  color: healthSyncFeedback.startsWith('✓') ? '#10b981' : '#ef4444',
                  fontWeight: 600,
                  padding: '4px 8px',
                  background: healthSyncFeedback.startsWith('✓') ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                  borderRadius: 4,
                  border: `1px solid ${healthSyncFeedback.startsWith('✓') ? '#10b981' : '#ef4444'}`,
                  whiteSpace: 'nowrap'
                }}
              >
                {healthSyncFeedback}
              </span>
            )}
          </div>
          {lastRefresh ? (<span style={{ fontSize: 12, opacity: .7 }}>Last: {new Date(lastRefresh).toLocaleTimeString()}</span>) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, opacity: .8 }}>Pending cancel:</span>
            <select value={pendingCancelAgeMin} onChange={e => onChangePendingCancel(Number(e.target.value))} style={{ fontSize: 12 }}>
              <option value={0}>Off</option>
              <option value={10}>10 min</option>
              <option value={20}>20 min</option>
              <option value={30}>30 min</option>
              <option value={40}>40 min</option>
              <option value={60}>60 min</option>
              <option value={90}>90 min</option>
              <option value={120}>120 min</option>
            </select>
          </div>
          {/* Sound controls */}
          <button 
            className="btn"
            onClick={handleToggleSound}
            title={soundEnabled ? 'Vypnout zvuky' : 'Zapnout zvuky'}
            style={{ padding: '2px 8px', fontSize: 16 }}
          >
            {soundEnabled ? '🔔' : '🔕'}
          </button>
          <button 
            className="btn"
            onClick={() => playPriceAlertSound()}
            title="Test zvuku"
            style={{ padding: '2px 8px', fontSize: 12 }}
          >
            🔊 Test
          </button>
        </div>
      </div>
      {error ? (
        <div className="error" style={{ marginTop: 8 }}>
          <strong style={{ color: 'crimson' }}>Error:</strong> <span style={{ fontSize: 12 }}>{error}</span>
        </div>
      ) : null}

      {/* Strategy Updater Control */}
      <div style={{ marginTop: 10, marginBottom: 8, padding: 8, border: '1px solid #333', borderRadius: 4, background: 'rgba(0,0,0,0.2)' }}>
        <StrategyUpdaterControl 
          hasPositions={positions.length > 0}
          hasActiveCountdowns={strategyUpdaterEntries.some((entry: any) => 
            entry.status === 'waiting' && new Date(entry.triggerAt).getTime() > Date.now()
          )}
        />
      </div>
      {/* Entry Updater Control */}
      <div style={{ marginTop: 10, marginBottom: 8, padding: 8, border: '1px solid #333', borderRadius: 4, background: 'rgba(0,0,0,0.2)' }}>
        <EntryUpdaterControl
          hasOpenEntries={orders.some(o => String(o.side).toUpperCase()==='SELL' && !(o.reduceOnly||o.closePosition))}
          hasActiveTimers={entryUpdaterEntries.some((e:any)=> e.status === 'waiting' && new Date(e.triggerAt).getTime() > Date.now())}
        />
      </div>
      {/* AI Profit Taker Control */}
      <div style={{ marginTop: 10, marginBottom: 8, padding: 8, border: '1px solid #333', borderRadius: 4, background: 'rgba(0,0,0,0.2)' }}>
        <AIProfitTakerControl
          hasPositions={positions.length > 0}
          lastRunTimestamp={aiProfitTakerLastRun}
        />
      </div>
      {/* Watcher Control */}
      <div style={{ marginTop: 10, marginBottom: 8, padding: 8, border: '1px solid #333', borderRadius: 4, background: 'rgba(0,0,0,0.2)' }}>
        <WatcherControl
          hasPositions={positions.length > 0}
          hasActiveTimers={watcherEntries.some((e:any)=> String(e?.status||'') === 'running' && Number.isFinite(Date.parse(String(e?.nextRunAt))) && new Date(e.nextRunAt).getTime() > Date.now())}
        />
      </div>
      {/* Top-Up Executor Control */}
      <div style={{ marginTop: 10, marginBottom: 8, padding: 8, border: '1px solid #333', borderRadius: 4, background: 'rgba(0,0,0,0.2)' }}>
        <TopUpExecutorStatus.Control
          hasPositions={positions.length > 0}
          hasActiveTimers={topUpExecutorEntries.some((e:any)=> e.status === 'waiting' && new Date(e.triggerAt).getTime() > Date.now())}
          enabled={topUpExecutorEnabled}
          onToggle={async (val: boolean) => {
            setTopUpExecutorEnabled(val)
            try {
              await fetch('/api/top_up_executor_toggle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: val })
              })
            } catch {}
          }}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Positions</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {lastRefresh ? (<span style={{ fontSize: 12, opacity: .75 }}>Refreshed: {new Date(lastRefresh as string).toLocaleTimeString()}</span>) : null}
            <button 
              className="btn" 
              onClick={() => {
                console.log('[ORDERS_PANEL] Toggle charts:', !showAllCharts, 'positions:', positionsView.length)
                setShowAllCharts(!showAllCharts)
              }}
              style={{ 
                background: showAllCharts ? '#1e40af' : '#1e293b',
                color: '#fff',
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600
              }}
            >
              📊 Charts
            </button>
            <button className="btn" onClick={flattenAllPositions} style={{ background: '#0d3a3a', border: '1px solid #106b6b', color: '#fff', padding: '2px 8px', fontSize: 12 }}>Flatten All</button>
            <span style={{ fontSize: 12, opacity: .8 }}>{positions.length}</span>
          </div>
        </div>
        {positionsView.some(p => p.isExternal) && (
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
            ⓘ External positions (LONG) are not shown in charts
          </div>
        )}
        {positionsView.length === 0 ? (
          <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No open positions</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 6 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Symbol</th>
                  <th style={{ textAlign: 'left' }}>Side</th>
                  <th style={{ textAlign: 'left' }}>Risk</th>
                  <th style={{ textAlign: 'right' }}>Size</th>
                  <th style={{ textAlign: 'right' }}>Entry</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Invested $</th>
                  <th style={{ textAlign: 'right' }}>P&L $</th>
                  <th style={{ textAlign: 'right' }}>P&L Lev %</th>
                  <th style={{ textAlign: 'right' }}>P&L %</th>
                  <th style={{ textAlign: 'right' }}>SL Lev % · TP Lev %</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'center' }}>Strategy Update</th>
                  {/* Profit Taker column removed */}
              <th style={{ textAlign: 'center' }}>Watcher</th>
                  <th style={{ textAlign: 'center' }}>Top-Up Executor</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {positionsView.map((p, idx) => {
                  const entry = strategyUpdaterEntries.find((e: any) => e.symbol === p.symbol) || null
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
                      <td>{(() => { const raw = String(lastRiskLabelBySymbol[p.symbol] || '') || '-'; const norm = raw.toLowerCase(); const pretty = norm.startsWith('ní')||norm==='low'?'Nízké': norm.startsWith('st')||norm==='medium'?'Střední': norm.startsWith('vy')||norm==='high'?'Vysoké': raw; return pretty; })()}</td>
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
                      <td style={{ textAlign: 'center' }}>
                        <StrategyUpdateStatus symbol={p.symbol} entry={entry} enabled={strategyUpdaterEnabled} />
                      </td>
                      {/* Profit Taker cell removed */}
                  <td style={{ textAlign: 'center' }}>
                    <WatcherStatus
                      symbol={p.symbol}
                      entry={watcherEntries.find((e:any) => e.symbol === p.symbol) || null}
                      enabled={watcherEnabled}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <TopUpExecutorStatus.Row
                      symbol={p.symbol}
                      entry={topUpExecutorEntries.find((e:any) => e.symbol === p.symbol) || null}
                      enabled={topUpExecutorEnabled}
                    />
                  </td>
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
        
        {/* Trading Charts Grid */}
        {showAllCharts && positionsViewForCharts.length > 0 && (
          <>
            <div style={{ 
              padding: 12, 
              background: '#1e293b', 
              borderRadius: 6, 
              marginTop: 16,
              fontSize: 13,
              color: '#94a3b8'
            }}>
              📊 Loading {visibleChartsCount} / {positionsViewForCharts.length} charts...
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(550px, 1fr))',
              gap: 16,
              marginTop: 16
            }}>
            {positionsViewForCharts.map((p, index) => {
              // Staggered loading: only show charts up to visibleChartsCount
              if (index >= visibleChartsCount) {
                return (
                  <div
                    key={`placeholder-${p.symbol}`}
                    style={{
                      width: 550,
                      height: 500,
                      background: '#0f172a',
                      border: '1px solid #1e293b',
                      borderRadius: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#64748b'
                    }}
                  >
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                      <div style={{ fontSize: 14 }}>Loading chart...</div>
                      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{p.symbol}</div>
                    </div>
                  </div>
                )
              }
              // Extract SL/TP from orders - CRITICAL FIX: Prioritize Strategy Updater orders
              const getSlTp = (symbol: string): { sl: number | null; tp: number | null } => {
                let sl = null
                let tp = null
                
                console.log(`[GET_SL_TP_START] ${symbol}: Total orders in array:`, orders.length)
                
                // Collect all SL and TP orders for this symbol
                const slOrders: OpenOrderUI[] = []
                const tpOrders: OpenOrderUI[] = []
                
                for (const order of orders) {
                  if (order.symbol !== symbol) continue
                  const type = String(order.type || '')
                  const closePos = Boolean(order.closePosition)
                  
                  console.log(`[GET_SL_TP_ORDER] ${symbol}:`, {
                    orderId: order.orderId,
                    type,
                    closePos,
                    clientOrderId: order.clientOrderId,
                    isStrategyUpdater: order.isStrategyUpdater,
                    price: order.price,
                    stopPrice: order.stopPrice
                  })
                  
                  if (type === 'STOP_MARKET' && closePos) {
                    slOrders.push(order)
                  }
                  // CRITICAL FIX: TP orders don't always have closePosition=true (e.g. TAKE_PROFIT with quantity)
                  // Accept TP orders if they have closePosition OR if type includes TAKE_PROFIT
                  if (type.includes('TAKE_PROFIT')) {
                    tpOrders.push(order)
                    console.log(`[GET_SL_TP_TP_FOUND] ${symbol}: Added to tpOrders`, {
                      orderId: order.orderId,
                      clientOrderId: order.clientOrderId,
                      isStrategyUpdater: order.isStrategyUpdater,
                      closePos
                    })
                  }
                }
                
                // Select best SL: prioritize Strategy Updater orders (x_ai_sl_), then newest
                if (slOrders.length > 0) {
                  const sorted = slOrders.sort((a, b) => {
                    // Priority 1: Strategy Updater orders first
                    const aIsAi = a.isStrategyUpdater || String(a.clientOrderId || '').includes('x_ai_sl_')
                    const bIsAi = b.isStrategyUpdater || String(b.clientOrderId || '').includes('x_ai_sl_')
                    if (aIsAi !== bIsAi) return aIsAi ? -1 : 1
                    
                    // Priority 2: Newest order (by createdAt)
                    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
                    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
                    return bTime - aTime  // Descending (newest first)
                  })
                  sl = Number(sorted[0].stopPrice) || null
                  
                  if (slOrders.length > 1) {
                    console.log(`[CHART_SL_SELECT] ${symbol}: Found ${slOrders.length} SL orders, selected:`, {
                      selected: { orderId: sorted[0].orderId, price: sl, clientOrderId: sorted[0].clientOrderId, isAI: sorted[0].isStrategyUpdater },
                      all: slOrders.map(o => ({ orderId: o.orderId, price: o.stopPrice, clientOrderId: o.clientOrderId, isAI: o.isStrategyUpdater }))
                    })
                  }
                }
                
                // Select best TP: prioritize Strategy Updater orders (x_ai_tp_), then newest
                if (tpOrders.length > 0) {
                  const sorted = tpOrders.sort((a, b) => {
                    // Priority 1: Strategy Updater orders first
                    const aIsAi = a.isStrategyUpdater || String(a.clientOrderId || '').includes('x_ai_tp_')
                    const bIsAi = b.isStrategyUpdater || String(b.clientOrderId || '').includes('x_ai_tp_')
                    if (aIsAi !== bIsAi) return aIsAi ? -1 : 1
                    
                    // Priority 2: Newest order (by createdAt)
                    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0
                    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0
                    return bTime - aTime  // Descending (newest first)
                  })
                  tp = Number(sorted[0].stopPrice || sorted[0].price) || null
                  
                  if (tpOrders.length > 1) {
                    console.log(`[CHART_TP_SELECT] ${symbol}: Found ${tpOrders.length} TP orders, selected:`, {
                      selected: { orderId: sorted[0].orderId, price: tp, clientOrderId: sorted[0].clientOrderId, isAI: sorted[0].isStrategyUpdater },
                      all: tpOrders.map(o => ({ orderId: o.orderId, price: o.stopPrice || o.price, clientOrderId: o.clientOrderId, isAI: o.isStrategyUpdater }))
                    })
                  }
                }
                
                console.log(`[GET_SL_TP_RESULT] ${symbol}:`, {
                  slOrders: slOrders.length,
                  tpOrders: tpOrders.length,
                  selectedSL: sl,
                  selectedTP: tp
                })
                
                return { sl, tp }
              }
              
              const { sl, tp } = getSlTp(p.symbol)
              
              console.log(`[CHART_PROPS] ${p.symbol}: Passing to chart:`, { sl, tp })
              
              // Calculate age in minutes
              const ageMinutes = (() => {
                if (!p.updatedAt) return 0
                try {
                  const ts = new Date(p.updatedAt).getTime()
                  if (!Number.isFinite(ts)) return 0
                  return Math.floor((Date.now() - ts) / 60000)
                } catch {
                  return 0
                }
              })()
              
              // Calculate available balance (mock for now - can be extracted from account info)
              const availableBalance = 0
              
              // Calculate position size in USD
              const positionSizeUsd = Number.isFinite(p.size) && Number.isFinite(p.entryPrice) 
                ? (p.size as number) * (p.entryPrice as number)
                : 0
              
              // CRITICAL: Use stable key to prevent unnecessary unmount/remount
              // CRITICAL: currentPrice MUST update every poll (5s)
              const currentPrice = (() => {
                // Priority 1: marks from polling (updates every 5s)
                const markFromPolling = marks[p.symbol]
                const now = Date.now()
                const timestamp = new Date(now).toISOString()
                const timeMs = new Date(now).getTime()
                
                console.log(`[ORDERS_PANEL] 🔄 Price source for ${p.symbol}:`, {
                  markFromPolling,
                  positionMarkPrice: p.markPrice,
                  marksKeys: Object.keys(marks),
                  timestamp,
                  timeMs,
                  positionsViewTimestamp: timestamp // Track memo recalculation
                })
                
                if (Number.isFinite(markFromPolling) && markFromPolling > 0) {
                  console.log(`[ORDERS_PANEL] ✅ Using markFromPolling: ${markFromPolling} at ${timestamp}`)
                  return markFromPolling
                }
                // Priority 2: position markPrice
                const positionMark = Number(p.markPrice)
                if (Number.isFinite(positionMark) && positionMark > 0) {
                  console.log(`[ORDERS_PANEL] ⚠️ Using positionMark: ${positionMark} at ${timestamp}`)
                  return positionMark
                }
                // Fallback: 0 (chart won't update)
                console.log(`[ORDERS_PANEL] ❌ NO VALID PRICE - using 0 at ${timestamp}`)
                return 0
              })()
              
              // Find health monitor entry for this symbol
              const healthEntry = healthMonitorEntries.find((e: any) => String(e?.symbol || '') === p.symbol)
              
              return (
                <PositionChartWithHealth
                  key={`chart-${p.symbol}-stable`}
                  symbol={p.symbol}
                  entryPrice={Number(p.entryPrice) || 0}
                  currentPrice={currentPrice}
                  slPrice={sl}
                  tpPrice={tp}
                  pnlUsd={Number(p.pnlUsd) || 0}
                  pnlPct={Number(p.pnlPct) || 0}
                  pnlPctLev={Number(p.pnlPctLev) || 0}
                  slLevPct={Number(p.slLevPct) || 0}
                  tpLevPct={Number(p.tpLevPct) || 0}
                  ageMinutes={ageMinutes}
                  leverage={Number(p.leverage) || 1}
                  availableBalance={availableBalance}
                  positionSizeUsd={positionSizeUsd}
                  positionSide={p.positionSide}
                  onClosePosition={flattenOne}
                  healthMonitorEntry={healthEntry}
                  healthMonitorEnabled={healthMonitorEnabled}
                />
              )
            })}
            </div>
          </>
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
                  <th style={{ textAlign: 'left' }}>Risk</th>
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
                {stableWaiting.map((w) => {
                  const suActive = strategyUpdaterEntries.some((e: any) => String(e?.symbol||'') === w.symbol)
                  return (
                  <tr key={w.symbol}>
                    <td>-</td>
                    <td>{w.symbol}</td>
                    <td>{(() => {
                      const ps = String(w.positionSide || '').toUpperCase()
                      if (ps === 'SHORT') return 'BUY'
                      if (ps === 'LONG') return 'SELL'
                      return '-'
                    })()}</td>
                    <td>{(() => {
                      const ps = String(w.positionSide||'')
                      if (!ps) return '-'
                      const col = ps==='LONG'?'#16a34a': ps==='SHORT'?'#dc2626': undefined
                      const strat = (lastStrategyBySymbol[w.symbol] || strategyFromOrdersBySymbol[w.symbol]) as ('aggressive'|'conservative'|undefined)
                      const suf = strat === 'aggressive' ? ' A' : (strat === 'conservative' ? ' C' : '')
                      return <span style={{ color: col }}>{ps}{suf}</span>
                    })()}</td>
                    <td>
                      <span>{'TAKE_PROFIT'}</span>
                      {suActive ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px', borderRadius: 4, background: '#22c55e', color: '#fff' }}>🤖 AI</span>
                      ) : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>{w.qtyPlanned ?? '-'}</td>
                    <td style={{ textAlign: 'right' }}>-</td>
                    <td style={{ textAlign: 'right' }}>-</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(Number(w.tp) * 1.03, 6)}</td>
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
                )})}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ height: 10 }} />
      
      {/* Cancel Delta % inline controls */}
      <div style={{ padding: '12px', background: 'rgba(255,255,255,0.02)', borderRadius: 4, marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span>Cancel Delta %:</span>
            <input 
              type="number" 
              min={0} 
              max={10} 
              step={0.5} 
              value={cancelDelta}
              onChange={e => setCancelDelta(Number(e.target.value))}
              style={{ width: 60, padding: 4, background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: 3 }}
              title="Pokud entry cena odchýlí od aktuální mark price o toto %, příkaz se zruší"
            />
          </label>
          <button 
            className="btn" 
            disabled={deltaLoading}
            onClick={async () => {
              setDeltaLoading(true)
              setDeltaFeedback(null)
              try {
                const res = await fetch('/api/config/trading', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    ENTRY_DELTA_CANCEL_PCT: Math.max(0, Math.min(10, cancelDelta))
                  })
                })
                if (res.ok) {
                  setDeltaFeedback('✓')
                  setTimeout(() => setDeltaFeedback(null), 2000)
                } else throw new Error('Failed')
              } catch {
                setDeltaFeedback('✗')
                setTimeout(() => setDeltaFeedback(null), 2000)
              } finally {
                setDeltaLoading(false)
              }
            }}
            style={{ fontSize: 12, padding: '4px 12px' }}
          >
            {deltaFeedback || (deltaLoading ? '...' : 'Save Delta Settings')}
          </button>
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Open Orders</strong>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {lastRefresh ? (<span style={{ fontSize: 12, opacity: .75 }}>Refreshed: {new Date(lastRefresh as string).toLocaleTimeString()}</span>) : null}
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
                  <th style={{ textAlign: 'center' }}>Entry Updater</th>
                  <th style={{ textAlign: 'center' }}>Health · Success</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Invested $</th>
                  <th style={{ textAlign: 'right' }}>Lev</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'right' }}>Stop</th>
                  <th style={{ textAlign: 'right' }}>Mark</th>
                  <th style={{ textAlign: 'right' }}>Δ%</th>
                  <th style={{ textAlign: 'left' }}>TIF</th>
                  <th style={{ textAlign: 'left' }}>Flags</th>
                  <th style={{ textAlign: 'left' }}>Risk</th>
                  <th style={{ textAlign: 'left' }}>Actions</th>
                  <th style={{ textAlign: 'left' }}>Updated</th>
                  <th style={{ textAlign: 'left' }}>Age</th>
                </tr>
              </thead>
              <tbody>
                {stableOrders.map((o) => {
                  const isStrategyOrder = isStrategyUpdaterOrder(o)
                  const isEntryUpdater = isEntryUpdaterOrder(o)
                  const isAIProfitTaker = isAIProfitTakerOrder(o)
                  // External badge only if NOT strategy/entry-updater/AI-PT order
                  const ext = isExternalOrder(o) && !isStrategyOrder && !isEntryUpdater && !isAIProfitTaker
                  const rowStyle = isStrategyOrder
                    ? { background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)' }
                    : (isEntryUpdater
                      ? { background: 'rgba(59, 130, 246, 0.15)', border: '1px solid rgba(59, 130, 246, 0.3)' }
                      : (isAIProfitTaker
                        ? { background: 'rgba(236, 72, 153, 0.15)', border: '1px solid rgba(236, 72, 153, 0.3)' }
                        : (ext ? { background: 'rgba(30,41,59,0.35)' } : undefined)))
                  return (
                  <tr key={o.orderId} style={rowStyle}>
                    <td>{o.orderId}</td>
                    <td>{o.symbol}</td>
                    <td>
                      {o.side}
                      {ext ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px', borderRadius: 4, background: '#334155', color: '#e2e8f0' }}>external</span>
                      ) : isStrategyOrder ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px', borderRadius: 4, background: '#22c55e', color: '#fff' }}>🤖 AI</span>
                      ) : isEntryUpdater ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px', borderRadius: 4, background: '#3b82f6', color: '#fff' }}>🤖 AI</span>
                      ) : isAIProfitTaker ? (
                        <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 4px', borderRadius: 4, background: '#ec4899', color: '#fff' }}>AI PT</span>
                      ) : null}
                    </td>
                    <td style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{(() => {
                      const ps = String(o.positionSide||'')
                      if (!ps) return '-'
                      const col = ps==='LONG'?'#16a34a': ps==='SHORT'?'#dc2626': undefined
                      const strat = lastStrategyBySymbol[o.symbol] || strategyFromOrdersBySymbol[o.symbol]
                      const suf = strat === 'aggressive' ? '\u00A0A' : (strat === 'conservative' ? '\u00A0C' : '')
                      return <span style={{ color: col }}>{ps}{suf}</span>
                    })()}</td>
                    <td>{(() => {
                      const t = String(o.type||'')
                      const isSL = /STOP_MARKET/i.test(t) && o.closePosition
                      const style = isSL ? { color: '#dc2626', fontWeight: 600 } : undefined
                      return <span style={style}>{t}</span>
                    })()}</td>
                    <td style={{ textAlign: 'center' }}>
                      {(() => {
                        // Find matching Entry Updater track for this orderId if present
                        const track = (entryUpdaterEntries as any[]).find((e:any)=> Number(e?.orderId) === Number(o.orderId)) || null
                        const enabled = entryUpdaterEnabled
                        if (!enabled) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
                        if (!track) return isEntryUpdater ? <span style={{ fontSize: 10, color: '#60a5fa' }} title="EU: waiting for first check">🔵 EU</span> : <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
                        const remainingSec = (()=>{ try { const t = new Date(track.triggerAt).getTime(); const now = Date.now(); return Math.max(0, Math.ceil((t-now)/1000)) } catch { return 0 } })()
                        const fmt = (sec:number) => { const m = Math.floor(sec/60); const s = sec%60; return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` }
                        const st = String(track.status||'waiting')
                        // Tooltip s poslední známou akcí z audit logu (lazy fetch přes latest endpoint)
                        const sym = String(o.symbol)
                        const last = euLastBySymbol[sym]
                        const lastStr = last && (last.phase || last.reason_code) ? ` | last: ${(last.phase||'').toUpperCase()}${last.reason_code?` (${last.reason_code})`:''}` : ''
                        const baseTitle = (st === 'processing' ? 'EU: Processing' : (remainingSec>0 ? `EU: next in ${fmt(remainingSec)}` : 'EU: Due')) + lastStr
                        if (st === 'processing') return <span style={{ fontSize: 10, color: '#3b82f6' }} title={baseTitle}>🔵 Processing</span>
                        if (st === 'completed') return <span style={{ fontSize: 10, color: '#22c55e' }} title="EU: Updated">✅ Updated</span>
                        return <span style={{ fontSize: 10, color: '#60a5fa' }} title={baseTitle}>🔵 {remainingSec>0?fmt(remainingSec):'Due'}</span>
                      })()}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {(() => {
                        // Show health/success ONLY for SELL entry orders (pending orders in SHORT system)
                        const isSellEntry = String(o.side || '').toUpperCase() === 'SELL' 
                          && !(o.reduceOnly || o.closePosition)
                        
                        if (!isSellEntry) {
                          return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
                        }
                        
                        // Match by orderId for pending orders
                        const healthEntry = healthMonitorEntries.find((e: any) => 
                          e.type === 'pending_order' && e.orderId === o.orderId
                        )
                        
                        // Debug logging
                        if (isSellEntry && o.orderId) {
                          console.log(`[HEALTH_DEBUG] Order ${o.symbol} #${o.orderId}:`, {
                            healthMonitorEnabled,
                            totalEntries: healthMonitorEntries.length,
                            pendingEntries: healthMonitorEntries.filter((e: any) => e.type === 'pending_order').length,
                            foundEntry: !!healthEntry,
                            hasLastOutput: healthEntry?.lastOutput ? true : false,
                            entryDetails: healthEntry ? {
                              symbol: healthEntry.symbol,
                              orderId: healthEntry.orderId,
                              type: healthEntry.type,
                              status: healthEntry.status,
                              lastOutput: healthEntry.lastOutput ? 'present' : 'null',
                              nextRunAt: healthEntry.nextRunAt
                            } : 'no entry found'
                          })
                        }
                        
                        if (!healthEntry || !healthMonitorEnabled) {
                          return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
                        }
                        
                        const lastOutput = healthEntry.lastOutput
                        if (!lastOutput) {
                          return <span style={{ fontSize: 10, color: '#6b7280' }}>⏳</span>
                        }
                        
                        const health = Number(lastOutput.health_pct)
                        const success = Number(lastOutput.success_prob_pct)
                        
                        // Color coding
                        const healthColor = health >= 70 ? '#22c55e' : health >= 40 ? '#f59e0b' : '#ef4444'
                        const successColor = success >= 70 ? '#22c55e' : success >= 50 ? '#f59e0b' : '#ef4444'
                        
                        return (
                          <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                            <div style={{ 
                              fontSize: '10px', 
                              background: healthColor,
                              color: '#fff',
                              padding: '2px 4px',
                              borderRadius: '3px',
                              fontWeight: 600
                            }} title={`Health: ${health}%`}>
                              H:{Math.round(health)}%
                            </div>
                            <div style={{ 
                              fontSize: '10px', 
                              background: successColor,
                              color: '#fff',
                              padding: '2px 4px',
                              borderRadius: '3px',
                              fontWeight: 600
                            }} title={`Success Probability: ${success}%`}>
                              S:{Math.round(success)}%
                            </div>
                          </div>
                        )
                      })()}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.qty, 4)}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      const isEntry = String(o.side).toUpperCase() === 'SELL' && !(o.reduceOnly || o.closePosition)
                      if (!isEntry) return '-'
                      // Use investedUsd from backend if available
                      const invested = Number((o as any)?.investedUsd)
                      if (Number.isFinite(invested) && invested > 0) {
                        return fmtNum(invested, 2)
                      }
                      return '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>{(() => {
                      // Use leverage from backend if available
                      const lev = Number((o as any)?.leverage)
                      return Number.isFinite(lev) && lev > 0 ? lev : '-'
                    })()}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.price, 6)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNum(o.stopPrice, 6)}</td>
                    <td style={{ textAlign: 'right' }}>{isEntryOrderUI(o) ? fmtNum(marks[o.symbol], 6) : '-'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {(() => {
                        const isEntry = isEntryOrderUI(o)
                        if (!isEntry) return '-'
                        // Compute Δ% ONLY when there is NO open position for this symbol
                        const hasOpenPos = (() => {
                          try { return Number.isFinite(Number(posBySymbol[o.symbol]?.size)) && Number(posBySymbol[o.symbol]?.size) > 0 } catch { return false } })()
                        if (hasOpenPos) return '-'
                        // Prefer server-precomputed value when present
                        const pre = Number((o as any)?.deltaPctEntry)
                        if (Number.isFinite(pre)) {
                          const color = colorForDelta(pre)
                          return <span style={{ color }} title={`Δ precomputed: ${pre.toFixed(4)}%`}>{fmtPct(pre, 2)}</span>
                        }
                        const m = Number(marks[o.symbol])
                        const tgtFromOrder = pickOrderTargetPrice(o)
                        const planned = Number((lastEntryBySymbol as any)[o.symbol])
                        const tgt = (Number.isFinite(tgtFromOrder as any) && Number(tgtFromOrder) > 0)
                          ? Number(tgtFromOrder)
                          : (Number.isFinite(planned) && planned > 0 ? planned : NaN)
                        if (Number.isFinite(m) && m > 0 && Number.isFinite(tgt) && tgt > 0) {
                          const pct = Math.abs(((tgt as number) - m) / m) * 100
                          const color = colorForDelta(pct)
                          return <span style={{ color }} title={`Δ calc: tgt=${tgt} mark=${m}`}>{fmtPct(pct, 2)}</span>
                        }
                        return '-'
                      })()}
                    </td>
                    <td>{o.timeInForce || '-'}</td>
                    <td>
                      {(() => {
                        const flags = [o.reduceOnly ? 'reduceOnly' : null, o.closePosition ? 'closePosition' : null].filter(Boolean).join(', ')
                        const warnNoSl = missingSlBySymbol.has(o.symbol)
                        return (
                          <span>
                            {flags || '-'}
                            {warnNoSl ? (
                              <>
                                <span style={{ marginLeft: 6, color: '#dc2626', fontWeight: 700 }} title="Missing SL for this symbol">no SL</span>
                                <button
                                  className="btn"
                                  onClick={async () => {
                                    try {
                                      const sl = Number(lastPlannedSLBySymbol[o.symbol])
                                      if (!Number.isFinite(sl) || sl <= 0) { setError(`No planned SL found for ${o.symbol}`); return }
                                      const r = await fetch('/api/place_exits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: o.symbol, sl, tp: null }) })
                                      if (!r.ok) {
                                        const j = await r.json().catch(()=>null)
                                        throw new Error(String(j?.error || `HTTP ${r.status}`))
                                      }
                                      await load(true)
                                    } catch (e:any) {
                                      setError(`recreate_sl_failed:${o.symbol}:${e?.message || 'unknown'}`)
                                    }
                                  }}
                                  style={{ marginLeft: 6, padding: '0 6px', fontSize: 11, background: '#3a0d0d', border: '1px solid #6b1010', color: '#fff' }}
                                  title="Recreate SL from planned value"
                                >Fix SL</button>
                              </>
                            ) : null}
                          </span>
                        )
                      })()}
                    </td>
                    <td>{(() => { const raw = String(lastRiskLabelBySymbol[o.symbol] || '') || '-'; const norm = raw.toLowerCase(); const pretty = norm.startsWith('ní')||norm==='low'?'Nízké': norm.startsWith('st')||norm==='medium'?'Střední': norm.startsWith('vy')||norm==='high'?'Vysoké': raw; return pretty; })()}</td>
                    <td>
                      {ext ? (
                        <span style={{ fontSize: 11, opacity: .6 }}>—</span>
                      ) : (
                        o.orderId ? (
                          <button
                            className="btn"
                            onClick={() => cancelOne(o.symbol, o.orderId)}
                            disabled={cancellingIds.has(o.orderId)}
                            title="Cancel order"
                            style={{ background: '#3a0d0d', border: '1px solid #6b1010', color: '#fff', padding: '0 6px', fontSize: 11 }}
                          >
                            {cancellingIds.has(o.orderId) ? '…' : 'Cancel'}
                          </button>
                        ) : '-'
                      )}
                    </td>
                    <td>{lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : '-'}</td>
                    <td>{(() => { const min = ageMinutes(o.createdAt || null); const color = colorForAge(min); return <span style={{ color }}>{fmtAge(min)}</span> })()}</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default OrdersPanel


