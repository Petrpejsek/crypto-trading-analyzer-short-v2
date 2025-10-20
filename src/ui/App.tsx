import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SnapshotBanner } from './components/SnapshotBanner';
import type { MarketRawSnapshot } from '../../types/market_raw';
import { computeFeatures } from '../../services/features/compute';
import type { FeaturesSnapshot } from '../../types/features';
import { decideFromFeatures, type MarketDecision } from '../../services/decider/rules_decider';
import { selectCandidates, type Candidate } from '../../services/signals/candidate_selector';
import type { SignalSet } from '../../services/signals/rules_signals';
import { HeaderBar } from './components/HeaderBar';
import { StatusPills, type WsHealth } from './components/StatusPills';
import { ErrorPanel } from './components/ErrorPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { downloadJson } from './utils/downloadJson';
import { ReportView } from './views/ReportView';
import { writeClipboard } from './utils/clipboard';
import { FeaturesPreview } from './components/FeaturesPreview';
import { DecisionBanner } from './components/DecisionBanner';
import { SetupsTable } from './components/SetupsTable';
// BtcInfoPanel removed - integrated into DecisionBanner
import { buildMarketCompact } from '../../services/decider/market_compact';
import signalsCfg from '../../config/signals.json';
// Final Picker input shape (client-side only; request will go to backend)
type FinalPickInput = {
  now_ts: number
  posture: 'OK' | 'CAUTION' | 'NO-TRADE'
  risk_policy: { ok: number; caution: number; no_trade: number }
  side_policy: 'long_only' | 'both'
  settings: {
    max_picks: number
    expiry_minutes: [number, number]
    tp_r_momentum: [number, number]
    tp_r_reclaim: [number, number]
    max_leverage: number
    max_picks_no_trade?: number
    confidence_floor_no_trade?: number
    risk_pct_no_trade_default?: number
  }
  candidates: Array<Record<string, any>>
}
import CandidatesPreview from './components/CandidatesPreview';
import { HotScreener, type HotPick } from './components/HotScreener';
import { EntryControls, type EntryStrategyData, type CoinControl } from './components/EntryControls';
import OrdersPanel from './components/OrdersPanel';
// import OrderDebugFooter from './components/OrderDebugFooter';
import PnlReportPanel from './components/PnlReportPanel'
import TradingHoursTrafficLight from './components/TradingHoursTrafficLight'
import FearGreedWidget from './components/FearGreedWidget'
import EntryPriceMultiplierWidget from './components/EntryPriceMultiplierWidget'
import { AiPayloadsPanel } from './components/AiPayloadsPanel'
import { PromptsModal } from './components/PromptsModal'
// Lightweight inline ActiveEntries Panel (detail + cancel)
const ActiveEntriesPanel: React.FC = () => {
  type Item = {
    id: string
    symbol?: string
    step?: string
    info?: string
    planned?: { entry: number|null; sl: number|null; tp: number|null; orderType?: string; side?: 'BUY'|'SELL' }
    entryOrderId?: string|number
    slOrderId?: string|number
    tpOrderId?: string|number
  }
  const [items, setItems] = useState<Item[]>([])
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<any>(null)

  const load = async () => {
    try {
      const r = await fetch('/api/temporal/entry/active')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      const ids: string[] = Array.isArray(j?.items) ? j.items.map((x: any)=>x.id).filter(Boolean) : []
      const details: Item[] = []
      for (const id of ids.slice(0, 20)) {
        try {
          const s = await fetch(`/api/temporal/entry/status?id=${encodeURIComponent(id)}`)
          if (s.ok) {
            const sj = await s.json()
            const st = sj?.status || {}
            details.push({
              id,
              symbol: st?.symbol,
              step: st?.step,
              info: st?.info,
              planned: st?.planned || undefined,
              entryOrderId: st?.entryOrderId,
              slOrderId: st?.slOrderId,
              tpOrderId: st?.tpOrderId
            })
          } else {
            details.push({ id })
          }
        } catch { details.push({ id }) }
      }
      setItems(details)
      setError(null)
    } catch (e: any) {
      setError(String(e?.message || e))
    }
  }

  const cancel = async (id: string) => {
    try {
      const r = await fetch('/api/temporal/entry/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setItems(prev => prev.filter(x => x.id !== id))
    } catch (e) {
      // soft-error; ponech zobrazené a nech poll další kolo
    }
  }

  useEffect(()=>{ load(); timer.current = setInterval(load, 3000); return ()=>{ if (timer.current) clearInterval(timer.current) } }, [])
  if (error) return <div style={{ color: 'crimson', fontSize: 12 }}>Active Entries error: {error}</div>
  if (items.length === 0) return <div style={{ fontSize: 12, opacity: .8 }}>No active entries</div>
  const fmt = (n: any) => {
    const v = Number(n)
    if (!Number.isFinite(v)) return '—'
    if (v === 0) return '0'
    return String(v)
  }
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
      {items.map(it => (
        <div key={it.id} style={{ padding: 8, border: '1px solid #2a2a2a', borderRadius: 6, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, opacity: .85 }}>ID: {it.id}</div>
            <button className="btn" style={{ padding: '2px 6px' }} onClick={()=>cancel(it.id)}>Cancel</button>
          </div>
          <div style={{ fontSize: 12 }}>Symbol: <strong>{it.symbol || '—'}</strong></div>
          <div style={{ fontSize: 12 }}>Step: {it.step || '—'}{it.info ? ` – ${it.info}` : ''}</div>
          <div style={{ fontSize: 12, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            <div>ENTRY: {fmt(it.planned?.entry)}</div>
            <div>SL: {fmt(it.planned?.sl)}</div>
            <div>TP: {fmt(it.planned?.tp)}</div>
          </div>
          <div style={{ fontSize: 12, opacity: .9 }}>Orders: entry #{it.entryOrderId || '—'}, SL #{it.slOrderId || '—'}, TP #{it.tpOrderId || '—'}</div>
        </div>
      ))}
    </div>
  )
}

export const App: React.FC = () => {
  // TTL for locally cached raw coin list (avoid stale list on ~5m pipeline)
  const RAW_COINS_TTL_MS = 4 * 60 * 1000;
  const [snapshot, setSnapshot] = useState<MarketRawSnapshot | null>(null);
  const [features, setFeatures] = useState<FeaturesSnapshot | null>(null);
  const [featuresMs, setFeaturesMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorPayload, setErrorPayload] = useState<any | null>(null);
  const [decision, setDecision] = useState<MarketDecision | null>(null);
  const [signalSet, setSignalSet] = useState<SignalSet | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [finalPicks, setFinalPicks] = useState<any[]>([]);
  const [finalPickerStatus, setFinalPickerStatus] = useState<'idle'|'loading'|'success'|'success_no_picks'|'error'>('idle');
  const [finalPickerMeta, setFinalPickerMeta] = useState<{ latencyMs?: number; error_code?: 'timeout'|'http'|'invalid_json'|'schema'|'post_validation'|'unknown'; error_message?: string; candidates: number; posture: 'OK'|'CAUTION'|'NO-TRADE' } | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [wsHealth, setWsHealth] = useState<WsHealth | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  // Hide snapshot/status container (per request we use Copy RAW flow only)
  const [showSnapshotBar] = useState(false);
  const [copiedSymbol, setCopiedSymbol] = useState<string | null>(null);
  const [rawCopied, setRawCopied] = useState(false);
  const [rawRegime, setRawRegime] = useState<{ btc_h1?: number | null } | null>(null)
  const [rawLoading, setRawLoading] = useState(false);
  const [loadingSymbol, setLoadingSymbol] = useState<string | null>(null);
  const [rawCoins, setRawCoins] = useState<any[] | null>(null);
  const [rawCoinsTs, setRawCoinsTs] = useState<number | null>(null);
  const [selectedUniverses, setSelectedUniverses] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('selected_universes')
      if (stored) {
        const parsed = JSON.parse(stored)
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch {}
    return ['losers']
  });
  const [currentRotationIndex, setCurrentRotationIndex] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('universe_rotation_index'))
      return Number.isFinite(n) && n >= 0 ? n : 0
    } catch { return 0 }
  })
  const prevStrategyRef = useRef(selectedUniverses[currentRotationIndex] || 'losers')
  useEffect(() => {
    const currentStrategy = selectedUniverses[currentRotationIndex] || 'losers'
    if (prevStrategyRef.current !== currentStrategy) {
      console.error(`[UNIVERSE_STRATEGY_CHANGED] from=${prevStrategyRef.current} to=${currentStrategy}`)
      setRawCoins(null)
      setRawCoinsTs(null)
      try { localStorage.removeItem('rawCoins') } catch {}
    }
    prevStrategyRef.current = currentStrategy
    // Persist to localStorage
    try { localStorage.setItem('selected_universes', JSON.stringify(selectedUniverses)) } catch {}
    try { localStorage.setItem('universe_rotation_index', String(currentRotationIndex)) } catch {}
  }, [selectedUniverses, currentRotationIndex])
  
  // Reset rotation index if out of bounds
  useEffect(() => {
    if (selectedUniverses.length === 0) {
      setCurrentRotationIndex(0)
    } else if (currentRotationIndex >= selectedUniverses.length) {
      setCurrentRotationIndex(0)
    }
  }, [selectedUniverses, currentRotationIndex])
  const [forceCandidates, setForceCandidates] = useState<boolean>(true);

  // Hot trading state
  const [hotPicks, setHotPicks] = useState<HotPick[]>([])
  const [hotScreenerStatus, setHotScreenerStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [selectedHotSymbols, setSelectedHotSymbols] = useState<string[]>([])
  const [blockedSymbols, setBlockedSymbols] = useState<string[]>([])
  // Store GPT entry inputs per symbol to enable copying selected payloads
  const [entryInputsBySymbol, setEntryInputsBySymbol] = useState<Record<string, { symbol: string; asset_data: any }>>({})
  // AI payloads (exact bodies sent to GPT endpoints)
  const [aiShowPanel, setAiShowPanel] = useState(false)
  const [aiHotScreenerBody, setAiHotScreenerBody] = useState<string | null>(null)
  const [aiEntryBodies, setAiEntryBodies] = useState<Array<{ symbol: string; body: string; sentAt: string }>>([])
  const [entryStrategies, setEntryStrategies] = useState<EntryStrategyData[]>([])
  const [riskBySymbol, setRiskBySymbol] = useState<Record<string, { decision: 'enter'|'skip'; risk_profile: 'conservative'|'aggressive'|null; prob_success: number|null; conservative_score?: number|null; aggressive_score?: number|null; reasons?: string[] }>>({})
  const riskBySymbolRef = useRef<Record<string, any>>({})
  const [entryControlsStatus, setEntryControlsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [coinControls, setCoinControls] = useState<CoinControl[]>([])
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
  // TODO: future – add markPrice map if needed
  const [placingOrders, setPlacingOrders] = useState(false)
  const [defaultPreset, setDefaultPreset] = useState<'conservative'|'aggressive'>(() => {
    try {
      const v = String(localStorage.getItem('ui_preset') || '').toLowerCase()
      return (v === 'aggressive' || v === 'conservative') ? (v as any) : 'conservative'
    } catch { return 'conservative' }
  })
  // Track last failed symbols to enable quick retry
  const [failedSymbols, setFailedSymbols] = useState<string[]>([])

  // Global defaults controlled in HeaderBar
  const [defaultSide, setDefaultSide] = useState<'LONG'|'SHORT'>(() => {
    try {
      const v = String(localStorage.getItem('ui_side') || '').toUpperCase()
      return (v === 'SHORT' || v === 'LONG') ? (v as any) : 'SHORT'
    } catch { return 'SHORT' }
  })
  const [defaultTPLevel, setDefaultTPLevel] = useState<'tp1'|'tp2'|'tp3'>(() => {
    try {
      const v = String(localStorage.getItem('ui_tp_level') || '').toLowerCase()
      return (v === 'tp1' || v === 'tp2' || v === 'tp3') ? (v as any) : 'tp2'
    } catch { return 'tp2' }
  })
  const [defaultAmount, setDefaultAmount] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('ui_amount'))
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20
    } catch { return 20 }
  })
  const [defaultLeverage, setDefaultLeverage] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem('ui_leverage'))
      return Number.isFinite(n) && n >= 1 && n <= 125 ? Math.floor(n) : 15
    } catch { return 15 }
  })

  // Load hot trading settings from localStorage
  const hotTradingSettings = useMemo(() => ({
    conservativeBuffer: 0,
    aggressiveBuffer: 0,
    maxPerCoin: 500,
    maxCoins: 40,  // Zvýšeno na 40 pro práci s velkým SHORT univerzem (70 kandidátů)
    defaultStrategy: 'conservative',
    defaultTPLevel: 'tp2',
    defaultLeverage: 15,
    defaultAmount: 20
  }), [])

  // Feature flag: use Temporal EntryAssistant instead of legacy /api/place_orders
  const useTemporalEntry = useMemo(() => {
    try {
      const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('use_temporal_entry') : null
      if (ls === '1') return true
    } catch {}
    try {
      const env = (import.meta as any)?.env?.VITE_USE_TEMPORAL_ENTRY
      return String(env || '') === '1'
    } catch { return false }
  }, [])

  // Auto Copy feature flags via localStorage (prefer new header keys)
  const useAutoCopy = useMemo(() => {
    try {
      const v1 = localStorage.getItem('use_auto_copy') === '1'
      const v2 = localStorage.getItem('auto_copy_enabled') === '1'
      return Boolean(v1 || v2)
    } catch { return false }
  }, [])
  // Note: interval minutes are read fresh when starting Auto Copy (see prepareOrders)
  const autoCopyIntervalMin = useMemo(() => {
    try {
      const raw = localStorage.getItem('auto_copy_minutes') ?? localStorage.getItem('auto_copy_interval_min') ?? '5'
      const v = Number(raw)
      return Number.isFinite(v) && v > 0 ? Math.floor(v) : 5
    } catch { return 5 }
  }, [])
  const [autoCopyId, setAutoCopyId] = useState<string | null>(() => {
    try { return localStorage.getItem('auto_copy_wf_id') } catch { return null }
  })
  const [autoCopyStatus, setAutoCopyStatus] = useState<{ round: number; paused: boolean; nextAt: string | null; lastResults: Array<{ symbol: string; ok: boolean }> } | null>(null)
  const [autoCopyError, setAutoCopyError] = useState<string | null>(null)
  const autoCopyPolling = useRef<ReturnType<typeof setInterval> | null>(null)
  const clearAutoCopyPolling = () => { if (autoCopyPolling.current) { clearInterval(autoCopyPolling.current); autoCopyPolling.current = null } }
  
  // Auto Copy - discovery on mount (run once)
  useEffect(() => {
    const discoverAutoCopy = async () => {
      try {
        // First check localStorage for known workflow ID
        const stored = localStorage.getItem('auto_copy_wf_id')
        if (stored) {
          // Verify it's still running
          const r = await fetch(`/api/temporal/auto_copy/status?id=${encodeURIComponent(stored)}`)
          if (r.ok) {
            const j = await r.json()
            if (j?.ok && j?.status && !j.status.completed) {
              setAutoCopyId(stored)
              setAutoCopyStatus(j.status)
              console.log('[AUTO_COPY_RESTORED_FROM_STORAGE]', { workflowId: stored, status: j.status })
              // Do NOT return; still check if there's a newer active workflow and prefer it
            }
          }
          // Stored workflow not running, clean up
          console.log('[AUTO_COPY_STORAGE_CLEANUP] Removing inactive workflow ID')
          localStorage.removeItem('auto_copy_wf_id')
        }
        
        // Always discover active workflow and prefer the newest one
        const activeResp = await fetch('/api/temporal/auto_copy/active')
        if (activeResp.ok) {
          const j = await activeResp.json()
          const wid = j?.workflowId || null
          if (wid && wid !== stored) {
            setAutoCopyId(wid)
            localStorage.setItem('auto_copy_wf_id', wid)
            console.log('[AUTO_COPY_DISCOVERED_ACTIVE]', { workflowId: wid })
            // Fetch initial status
            const statusResp = await fetch(`/api/temporal/auto_copy/status?id=${encodeURIComponent(wid)}`)
            if (statusResp.ok) {
              const sj = await statusResp.json()
              if (sj?.ok && sj?.status) {
                setAutoCopyStatus(sj.status)
              }
            }
          }
        }
      } catch (e) {
        console.error('[AUTO_COPY_DISCOVERY_ERROR]', e)
      }
    }
    
    discoverAutoCopy()
  }, []) // Empty deps = run once on mount ONLY
  
  // Auto Copy - polling for status updates
  useEffect(() => {
    clearAutoCopyPolling()
    if (!autoCopyId) return
    const load = async () => {
      try {
        const res = await fetch(`/api/temporal/auto_copy/status?id=${encodeURIComponent(autoCopyId)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        if (j?.ok) setAutoCopyStatus(j.status || null)
      } catch (e: any) {
        setAutoCopyError(String(e?.message || e))
      }
    }
    load().catch(()=>{})
    autoCopyPolling.current = setInterval(load, 3000)
    return clearAutoCopyPolling
  }, [autoCopyId])
  const stopAutoCopy = async (cmd: 'pause'|'resume'|'cancel') => {
    try {
      if (!autoCopyId) return
      const r = await fetch('/api/temporal/auto_copy/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: autoCopyId, cmd }) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      if (cmd === 'cancel') {
        setAutoCopyId(null)
        setAutoCopyStatus(null)
        try { localStorage.removeItem('auto_copy_wf_id') } catch {}
      } else {
        // status will refresh on next poll
      }
    } catch (e: any) {
      setError(`Auto Copy command error: ${e?.message || 'unknown'}`)
    }
  }

  const symbolsLoaded = useMemo(() => {
    if (!snapshot) return 0;
    const core = ['BTCUSDT', 'ETHUSDT'];
    const uni = snapshot.universe?.length ?? 0;
    return core.length + uni;
  }, [snapshot]);

  const formatSymbol = (sym: string, sep: '/' | '-' = '/'): string => {
    try {
      if (sym.endsWith('USDT')) return `${sym.slice(0, -4)}${sep}USDT`
      return sym
    } catch { return sym }
  }

  // NOVÁ FUNKCE: Konzistentní výpočet změn procent (opravuje chybu #1)
  const calculateChangePercent = (current: number, previous: number): number | null => {
    try {
      if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
        return null
      }
      return ((current / previous) - 1) * 100
    } catch {
      return null
    }
  }

  // Globální helper: retry pro dočasné chyby (502/503/504) a network abort/timeout
  const fetchWithRetry = async (input: string, init: RequestInit = {}, tries = 3, baseDelayMs = 400): Promise<Response> => {
    let lastErr: any
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(input, init)
        if (res.ok) return res
        if (![502,503,504].includes(res.status)) return res
      } catch (e: any) {
        lastErr = e
      }
      const jitter = Math.floor(Math.random() * 200)
      await new Promise(r => setTimeout(r, baseDelayMs + i * 300 + jitter))
    }
    if (lastErr) throw lastErr
    return fetch(input, init)
  }

  const coinsSource = useMemo(() => {
    // STRICT: použij pouze fresh rawCoins, jinak prázdný seznam
    if (!rawCoins || !Array.isArray(rawCoins) || rawCoins.length === 0) return []
    const ts = rawCoinsTs ?? null
    if (!Number.isFinite(ts as any)) return []
    return (Date.now() - (ts as number)) <= RAW_COINS_TTL_MS ? rawCoins : []
  }, [rawCoins, rawCoinsTs])
  
  const columns = 3
  const displayCoins = useMemo(() => {
    // Alt universe = přesně RAW coiny z Copy RAW (vstup do Hot Screeneru)
    // Trvale vyloučit BTC/ETH z výpisu
    const list = Array.isArray(coinsSource) && coinsSource.length > 0
      ? coinsSource
          .map((c: any) => ({ symbol: String(c?.symbol || '') }))
          .filter((u: any) => Boolean(u.symbol))
          .filter((u: any) => {
            const s = u.symbol.toUpperCase()
            return s !== 'BTCUSDT' && s !== 'ETHUSDT'
          })
      : []
    const rows = Math.ceil(list.length / columns)
    const ordered: any[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const idx = r + c * rows
        if (idx < list.length) ordered.push(list[idx])
      }
    }
    return ordered
  }, [coinsSource])
  const snapshotAgeMs = useMemo(() => {
    try {
      const ts = snapshot?.timestamp ? Date.parse(snapshot.timestamp) : null
      return ts ? (Date.now() - ts) : null
    } catch { return null }
  }, [snapshot])

  const onRun = async () => {
    console.log('🚫 onRun() called - checking if triggered automatically');
    setRunning(true);
    setError(null);
    setErrorPayload(null);
    try {
      const nowMs = Date.now();
      setRunStartedAt(nowMs);
      try { localStorage.setItem('lastRunAtMs', String(nowMs)) } catch {}
      async function fetchJsonWithTimeout<T=any>(input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; json: T | null }> {
        const ac = new AbortController()
        const timeoutMs = init.timeoutMs ?? 600000 // 10 minut pro GPT-5 volání
        const to = window.setTimeout(() => {
          try {
            // Provide an explicit reason so the browser error is meaningful
            ac.abort(new DOMException(`timeout after ${timeoutMs}ms`, 'TimeoutError'))
          } catch {
            ac.abort()
          }
        }, timeoutMs)
        try {
          const res = await fetch(input, { ...init, signal: ac.signal })
          const status = res.status
          let json: any = null
          try { json = await res.json() } catch {}
          return { ok: res.ok, status, json }
        } catch (err: any) {
          if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
            throw new Error(`Request timeout after ${timeoutMs}ms for ${typeof input === 'string' ? input : (input as URL).toString()}`)
          }
          throw err
        } finally { clearTimeout(to) }
      }

      // removed: local fetchWithRetry (using module-level helper)

      const currentStrategy = selectedUniverses[currentRotationIndex] || 'losers'
      const snapUrl = currentStrategy === 'overheat'
        ? `/api/snapshot_overheat?topN=70&fresh=1`
        : `/api/snapshot?universe=${currentStrategy}&topN=70`
      console.error(`[SNAPSHOT_API_CALL] universeStrategy=${currentStrategy}, url=${snapUrl}`)
      const snap = await fetchJsonWithTimeout<MarketRawSnapshot>(snapUrl, { timeoutMs: 300000 }) // 5 minut pro snapshot
      if (!snap.ok) {
        if (snap.json) { setErrorPayload(snap.json); throw new Error((snap.json as any)?.error || `HTTP ${snap.status}`) }
        throw new Error(`HTTP ${snap.status}`);
      }
      const data = snap.json as MarketRawSnapshot
      setSnapshot(data);
      // compute features
      const t0 = performance.now();
      const feats = computeFeatures(data);
      const dt = performance.now() - t0;
      setFeatures(feats);
      setFeaturesMs(dt);
      // M3: strict GPT via backend when enabled; no silent fallback
      let dec: MarketDecision
      const mode = String((import.meta as any).env?.VITE_DECIDER_MODE || (globalThis as any).DECIDER_MODE || 'mock').toLowerCase()
      if (mode === 'gpt') {
        const compact = buildMarketCompact(feats, data)
        const resp = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(compact) })
        if (resp.ok) {
          dec = await resp.json()
          try {
            const meta = (dec as any)?.meta || {}
            const reasons: string[] = Array.isArray((dec as any)?.reasons) ? (dec as any).reasons : []
            const status = reasons.some((r: string) => String(r||'').startsWith('gpt_error:')) ? 'error' : 'ok'
            const m = { status, latencyMs: Number(meta.latencyMs ?? 0), error_code: meta.error_code ?? null, prompt_hash: meta.prompt_hash ?? null, schema_version: meta.schema_version ?? null, http_status: meta.http_status ?? null, http_error: meta.http_error ?? null }
            localStorage.setItem('m3DecisionMeta', JSON.stringify(m))
          } catch {}
        } else {
          dec = { flag: 'NO-TRADE', posture: 'RISK-OFF', market_health: 0, expiry_minutes: 30, reasons: ['gpt_error:http'], risk_cap: { max_concurrent: 0, risk_per_trade_max: 0 } }
          try { localStorage.setItem('m3DecisionMeta', JSON.stringify({ status: 'error', error_code: 'http', latencyMs: 0 })) } catch {}
        }
      } else {
        dec = decideFromFeatures(feats)
      }
      setDecision(dec);

      // Candidates preview + canComputeSimPreview flag
      try {
        const sCfg: any = (await import('../../config/signals.json')).default || (signalsCfg as any)
        // Show candidate preview in NO-TRADE by default unless explicitly turned off in config
        const allowPreview = dec.flag === 'NO-TRADE' ? ((sCfg.preview_when_no_trade !== false) && forceCandidates) : false
        const candLimit = allowPreview ? (sCfg.preview_limit ?? 5) : (sCfg.max_setups ?? 3)
        const execMode = (() => { try { return localStorage.getItem('execution_mode') === '1' } catch { return false } })()
        // New rule: allow sim preview only for NO-TRADE + success_no_picks + execution_mode=false
        const canComputeSimPreview = (dec.flag === 'NO-TRADE' && finalPickerStatus === 'success_no_picks' && !execMode)
        const candList = selectCandidates(feats, data, {
          decisionFlag: dec.flag as any,
          allowWhenNoTrade: Boolean((sCfg as any)?.allowWhenNoTrade === true) || allowPreview,
          limit: 50,  // FIXED: přímý limit 50 pro plný downtrend pool
          cfg: { atr_pct_min: sCfg.atr_pct_min, atr_pct_max: sCfg.atr_pct_max, min_liquidity_usdt: sCfg.min_liquidity_usdt },
          canComputeSimPreview,
          finalPickerStatus,
          universeStrategy: currentStrategy  // Předáme universe strategy do candidate selectoru
        } as any)
        setCandidates(candList)
        // Pokud je strategie overheat, omez alt universe jen na vybrané kandidáty
        if (currentStrategy === 'overheat' && snap?.json?.universe) {
          try {
            const candSyms = new Set(candList.map(c => c.symbol))
            const filtered = (snap.json as any).universe.filter((u: any) => candSyms.has(u.symbol))
            setRawCoins(filtered)
          } catch {}
        }
      } catch {}

      // Final Picker strict no-fallback
      setFinalPicks([])
      setSignalSet({ setups: [] } as any)
      setFinalPickerStatus('idle')
      setFinalPickerMeta({ candidates: candidates.length, posture: dec.flag as any })

      const deciderCfg: any = (await import('../../config/decider.json')).default
      const fpCfg = deciderCfg?.final_picker || {}
      const fpEnabled = fpCfg?.enabled !== false
      const allowNoTrade = fpCfg?.allow_picks_in_no_trade === true
      const shouldCallFinalPicker = fpEnabled && candidates.length > 0 && (
        dec.flag === 'OK' || dec.flag === 'CAUTION' || (dec.flag === 'NO-TRADE' && allowNoTrade)
      )
      if (shouldCallFinalPicker) {
        setFinalPickerStatus('loading')
        try {
          const sigCfg: any = (await import('../../config/signals.json')).default || (signalsCfg as any)
          const maxPicks = Math.max(1, Math.min(6, sigCfg?.max_setups ?? 3))
          const sidePolicyRaw = (() => { try { return (localStorage.getItem('side_policy') as any) || 'both' } catch { return 'both' } })()
          const sidePolicy: 'long_only' | 'both' = sidePolicyRaw === 'long_only' ? 'long_only' : 'both'
          const input: FinalPickInput = {
            now_ts: Date.now(),
            posture: dec.flag as any,
            risk_policy: { ok: 0.5, caution: 0.25, no_trade: 0.0 },
            side_policy: sidePolicy,
            settings: {
              max_picks: maxPicks,
              expiry_minutes: [60, 90],
              tp_r_momentum: [1.2, 2.5],
              tp_r_reclaim: [1.0, 2.0],
              max_leverage: (() => { try { const v = Number(localStorage.getItem('max_leverage')); return Number.isFinite(v) ? v : 20 } catch { return 20 } })(),
              // no-trade advisory parameters
              max_picks_no_trade: Number(fpCfg.max_picks_no_trade ?? 3) as any,
              confidence_floor_no_trade: Number(fpCfg.confidence_floor_no_trade ?? 0.65) as any,
              risk_pct_no_trade_default: Number(fpCfg.risk_pct_no_trade_default ?? 0.0) as any
            } as any,
            candidates: [...candidates].sort((a,b)=> a.symbol.localeCompare(b.symbol)).map((c:any) => ({
              symbol: c.symbol,
              price: (features as any)?.universe?.find((u:any)=>u.symbol===c.symbol)?.price ?? null,
              ret_m15_pct: null,
              ret_h1_pct: null,
              rvol_m15: null,
              rvol_h1: null,
              atr_pct_h1: c.atrPctH1 ?? c.atr_pct_H1 ?? null,
              ema_stack: ['20>50>200','20>200>50','50>20>200'].includes((c as any).ema_order_H1) ? 1 : (['200>50>20','200>20>50','50>200>20'].includes((c as any).ema_order_H1) ? -1 : 0),
              vwap_rel_m15: (c as any).vwap_rel_M15 ?? null,
              oi_change_pct_h1: null,
              funding_rate: null,
              funding_z: null,
              quoteVolumeUSDT: (c as any).volume24h_usd ?? null,
              tradesCount: null,
              is_new: false,
              h1_range_pos_pct: null,
              hh_h1: null,
              ll_h1: null,
              vwap_m15: null
            }))
          }
          // Call backend Final Picker (node-side runs GPT + validation)
          const fpResp = await fetchJsonWithTimeout('/api/final_picker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 600000 }) // 10 minut pro final picker
          const res = fpResp.ok ? (fpResp.json || { ok: false, code: 'unknown', latencyMs: 0, data: { picks: [] } }) : { ok: false, code: (fpResp.status === 0 ? 'timeout' : 'http'), latencyMs: 0, data: { picks: [] }, meta: { http_status: fpResp.status } }
          const saveTelem = (status: string, code?: string, latency?: number, picksCount?: number) => {
            const telem = {
              ts: new Date().toISOString(), posture: dec.flag, candidatesCount: candidates.length, status,
              picksCount: picksCount ?? 0, advisory: dec.flag === 'NO-TRADE',
              no_trade: {
                allow: allowNoTrade,
                maxPicks: Number(fpCfg.max_picks_no_trade ?? 3),
                confFloor: Number(fpCfg.confidence_floor_no_trade ?? 0.65),
                riskDefault: Number(fpCfg.risk_pct_no_trade_default ?? 0.0)
              },
              settings_snapshot: { max_leverage: input.settings.max_leverage },
              latencyMs: latency ?? 0, error_code: code,
              post_validation_checks: (res as any)?.meta?.post_validation_checks ?? null,
              filtered_counts: (res as any)?.meta?.filtered_counts ?? null,
              prompt_hash: (res as any)?.meta?.prompt_hash ?? null,
              schema_version: (res as any)?.meta?.schema_version ?? null
            }
            try { localStorage.setItem('m4FinalPicker', JSON.stringify(telem)); if (picksCount != null) localStorage.setItem('m4FinalPicks', JSON.stringify(res?.data?.picks ?? [])) } catch {}
            // eslint-disable-next-line no-console
            try { const mode = (import.meta as any)?.env?.MODE || (process as any)?.env?.NODE_ENV; if (mode !== 'production') console.info('finalPicker', { code, latencyMs: latency ?? 0 }) } catch {}
          }
          if (!res.ok) {
            setFinalPickerStatus('error')
            setFinalPickerMeta({ latencyMs: res.latencyMs, error_code: res.code as any, candidates: candidates.length, posture: dec.flag as any })
            setFinalPicks([])
            setSignalSet({ setups: [] } as any)
            saveTelem('error', res.code, res.latencyMs, 0)
          } else {
            const picks = Array.isArray(res.data?.picks) ? res.data.picks : []
            // Post-validation
            const maxLev = input.settings.max_leverage
            const [expMin, expMax] = input.settings.expiry_minutes
            const rp = dec.flag === 'OK' ? 0.5 : dec.flag === 'CAUTION' ? 0.25 : 0
            const bad = picks.find((p:any) => {
              const side = p.side
              // SHORT system - validate SHORT price order
              const okOrder = side === 'SHORT'
                ? (p.tp1 <= p.tp2 && p.tp2 < p.entry && p.entry < p.sl)
                : (p.tp1 <= p.tp2 && p.tp2 < p.entry && p.entry < p.sl)
              const okRisk = Math.abs((p.risk_pct ?? rp) - rp) < 1e-6
              const okLev = (p.leverage_hint ?? 1) <= maxLev
              const okExp = (p.expiry_minutes ?? 0) >= expMin && (p.expiry_minutes ?? 0) <= expMax
              return !(okOrder && okRisk && okLev && okExp)
            })
            if (bad) {
              setFinalPickerStatus('error')
              setFinalPickerMeta({ latencyMs: res.latencyMs, error_code: 'post_validation', candidates: candidates.length, posture: dec.flag as any })
              setFinalPicks([])
              setSignalSet({ setups: [] } as any)
              saveTelem('error', 'post_validation', res.latencyMs, 0)
            } else if (picks.length === 0) {
              setFinalPickerStatus('success_no_picks')
              setFinalPicks([])
              setSignalSet({ setups: [] } as any)
              saveTelem('success_no_picks', undefined, res.latencyMs, 0)
            } else {
              setFinalPickerStatus('success')
              setFinalPicks(picks)
              const setups = picks.map((p:any) => ({ symbol: p.symbol, side: p.side, entry: p.entry, sl: p.sl, tp: [p.tp1,p.tp2].filter(Boolean), sizing: { risk_pct: p.risk_pct ?? rp }, expires_in_min: p.expiry_minutes ?? 60, label: p.label, setup_type: p.setup_type, leverage_hint: p.leverage_hint, confidence: p.confidence, reasons: p.reasons }))
              setSignalSet({ setups } as any)
              saveTelem('success', undefined, res.latencyMs, picks.length)
            }
          }
        } catch (e:any) {
          setFinalPickerStatus('error')
          setFinalPickerMeta({ error_code: 'unknown', candidates: candidates.length, posture: dec.flag as any })
          setFinalPicks([])
          setSignalSet({ setups: [] } as any)
          const telem = {
            ts: new Date().toISOString(), posture: dec.flag, candidatesCount: candidates.length, status: 'error', picksCount: 0,
            advisory: dec.flag === 'NO-TRADE', no_trade: { allow: allowNoTrade, maxPicks: Number(fpCfg.max_picks_no_trade ?? 3), confFloor: Number(fpCfg.confidence_floor_no_trade ?? 0.65), riskDefault: Number(fpCfg.risk_pct_no_trade_default ?? 0.0) }, settings_snapshot: { max_leverage: (()=>{ try { const v = Number(localStorage.getItem('max_leverage')); return Number.isFinite(v) ? v : 20 } catch { return 20 } })() }, latencyMs: 0, error_code: 'unknown'
          }
          try { localStorage.setItem('m4FinalPicker', JSON.stringify(telem)); localStorage.setItem('m4FinalPicks', JSON.stringify([])) } catch {}
        }
      }

      setLastRunAt(new Date().toISOString());
      setError(undefined as any);
      setErrorPayload(null);
      // console table summary
      // eslint-disable-next-line no-console
      console.table({ durationMs: Math.round((data as any).duration_ms ?? (data as any).latency_ms ?? 0), featuresMs: Math.round(dt), symbols: data.universe.length, setups: (signalSet as any)?.setups?.length ?? 0 });
      // no persist: always fresh data per run (no localStorage caching of market data)
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  const onExport = () => { if (snapshot) downloadJson(snapshot, 'snapshot') };

  const onExportFeatures = () => { if (features) downloadJson(features, 'features') };

  // Use centralized clipboard util everywhere
  const writeClipboardSafely = async (text: string, { requireFocusForAuto = true }: { requireFocusForAuto?: boolean } = {}) => {
    return writeClipboard(text, { requireFocusForAuto })
  }

  const copyCoin = async (symbol: string) => {
    const sym = String(symbol || '')
    console.log('[COPY_COIN] Clicked symbol:', sym)
    if (!sym) return
    // Clear previous copied state to avoid confusion
    setCopiedSymbol(null)
    setLoadingSymbol(sym)
    try {
      const q = ''
      const sep = q ? '&' : '?'
      console.log('[COPY_COIN] Fetching:', `/api/intraday_any?symbol=${encodeURIComponent(sym)}`)
      const res = await fetchWithRetry(`/api/intraday_any?symbol=${encodeURIComponent(sym)}`)
      if (res.ok) {
        const json: any = await res.json()
        const assets: any[] = Array.isArray(json?.assets) ? json.assets : []
        const asset = assets.find(a => a?.symbol === sym) || null
        console.log('[COPY_COIN] Found asset:', asset?.symbol || 'none')
        if (asset) {
          try {
            await writeClipboardSafely(JSON.stringify(asset, null, 2))
          } catch (e: any) {
            if (String(e?.code || e?.message || '') === 'document_not_focused') {
              console.info('Clipboard skipped: document not focused')
            } else {
              setError(`Clipboard error: ${e?.message || 'write failed'}`)
            }
            return
          }
          setCopiedSymbol(sym)
          window.setTimeout(() => setCopiedSymbol(null), 1200)
        } else {
          setError(`${sym} not available in current universe (only 48 alts loaded). Try "Run now" first.`)
        }
      } else {
        let msg = `HTTP ${res.status} for /api/intraday_any?symbol=${sym}`
        try { const j = await res.json(); if (j?.error) msg = `${j.error} (${res.status}) for ${sym}` } catch {}
        setError(msg)
      }
    } catch {}
    finally { setLoadingSymbol(null) }
  }

  const copyRawAll = async () => {
    // Validace: v manuálním režimu může být pouze 1 checkbox zaškrtnutý
    const isAutoMode = (() => {
      try { return localStorage.getItem('auto_copy_enabled') === '1' } catch { return false }
    })()
    if (!isAutoMode && selectedUniverses.length > 1) {
      setError('Pro Copy RAW v manuálním režimu může být aktivní pouze 1 strategie. Pro více strategií zapněte Auto Copy RAW.')
      return
    }
    if (selectedUniverses.length === 0) {
      setError('Vyberte alespoň jednu strategii')
      return
    }
    
    setRawLoading(true)
    // Clear previous UI error state before fresh fetch
    setError(null)
    try {
      const currentStrategy = selectedUniverses[currentRotationIndex] || 'losers'
      const uni = encodeURIComponent(currentStrategy)
      const q = `universe=${uni}&topN=70&side=short`
      const res = await fetchWithRetry(`/api/metrics?${q}`)
      if (!res.ok) {
        setError(`Server error: HTTP ${res.status}`)
        return
      }
      const json: any = await res.json()
      
      // VALIDACE: Ověření struktury dat
      if (!json || typeof json !== 'object') {
        setError('Invalid response format from server')
        return
      }
      
      let coins = Array.isArray(json?.coins) ? json.coins : []
      // Dedup on client as safeguard
      try {
        const seen = new Set<string>()
        coins = coins.filter((c:any) => {
          const s = String(c?.symbol||'')
          if (!s) return false
          if (seen.has(s)) return false
          seen.add(s)
          return true
        })
      } catch {}
      if (coins.length === 0) {
        setError('No coins data received from server')
        return
      }
      
      // Update UI state (no localStorage persistence of rawCoins)
      setRawCoins(coins)
      setRawCoinsTs(Date.now())
      // Success: ensure any stale error banner is cleared
      setError(null)
      
      // OPRAVA: Validované BTC/ETH regime calculations
      try {
        const btcChange = json?.regime?.BTCUSDT?.h1_change_pct
        const ethChange = json?.regime?.ETHUSDT?.h1_change_pct
        const btc = Number.isFinite(btcChange) ? Number(btcChange) : null
        const eth = Number.isFinite(ethChange) ? Number(ethChange) : null
        
        if (btc !== null) setRawRegime({ btc_h1: btc })
        
        // Bezpečný průměr s validací
        if (btc !== null && eth !== null) {
          const avg = (btc + eth) / 2
          const status: 'idle'|'loading'|'success'|'success_no_picks'|'error' = 
            avg > 0.5 ? 'success' : avg < -0.5 ? 'error' : 'success_no_picks'
          setFinalPickerStatus(status)
        }
      } catch (e: any) {
        console.warn('Regime calculation failed:', e?.message)
      }
      
      // OPRAVA: Validace velikosti před kopírováním – při chybě NEUKONČUJEME flow
      {
        let copiedOk = false
        try {
          const jsonString = JSON.stringify(coins, null, 2)
          const sizeKB = new Blob([jsonString]).size / 1024
          if (sizeKB > 1024) {
            setError(`Data too large for clipboard (${sizeKB.toFixed(0)}KB). Max 1MB allowed.`)
          } else {
            await writeClipboardSafely(jsonString)
            copiedOk = true
          }
        } catch (e: any) {
          if (String(e?.code || e?.message || '') === 'document_not_focused') {
            console.info('Clipboard skipped: document not focused')
          } else {
            setError(`Clipboard error: ${e?.message || 'write failed'}`)
          }
        }
        if (copiedOk) {
          setRawCopied(true)
          window.setTimeout(() => setRawCopied(false), 1400)
        }
      }

      // Auto-trigger hot screener (pokračuj i když clipboard selže)
      await runHotScreener(coins)
      
      // Rotation logic: move to next selected strategy (for auto mode)
      if (selectedUniverses.length > 1) {
        const nextIndex = (currentRotationIndex + 1) % selectedUniverses.length
        setCurrentRotationIndex(nextIndex)
        console.log('[UNIVERSE_ROTATION]', { 
          from: selectedUniverses[currentRotationIndex], 
          to: selectedUniverses[nextIndex],
          index: nextIndex 
        })
      }
    } catch (e: any) {
      setError(`Network error: ${e?.message || 'request failed'}`)
    } finally { 
      setRawLoading(false) 
    }
  }

  // Copy GPT payloads for currently selected hot symbols (requires Analyze selected to have fetched inputs)
  const [selectedCopied, setSelectedCopied] = useState(false)
  const copySelectedEntryInputs = async () => {
    try {
      if (!Array.isArray(selectedHotSymbols) || selectedHotSymbols.length === 0) {
        setError('No selected symbols. Select at least one Super Hot coin.');
        return
      }
      const payloads = selectedHotSymbols
        .map(sym => entryInputsBySymbol[sym])
        .filter(Boolean)
      if (payloads.length === 0) {
        setError('No entry inputs available. Run Analyze selected first.');
        return
      }
      const text = JSON.stringify(payloads, null, 2)
      await writeClipboardSafely(text)
      setSelectedCopied(true)
      window.setTimeout(()=>setSelectedCopied(false), 1200)
    } catch (e: any) {
      if (String(e?.code || e?.message || '') === 'document_not_focused') {
        console.info('Clipboard skipped: document not focused')
      } else {
        setError(`Clipboard error: ${e?.message || 'write failed'}`)
      }
    }
  }

  // Hot trading functions
  const runHotScreener = async (coins: any[]) => {
    setHotScreenerStatus('loading')
    setHotPicks([])
    setSelectedHotSymbols([])
    
    try {
      const currentStrategy = selectedUniverses[currentRotationIndex] || 'losers'
      
      // FRESHNESS VALIDATION: Check if coins data is recent (< 60s old)
      if (Array.isArray(coins) && coins.length > 0) {
        const firstCoin = coins[0]
        if (firstCoin && firstCoin.timestamp) {
          const now = Date.now()
          const coinTime = new Date(firstCoin.timestamp).getTime()
          const ageSeconds = (now - coinTime) / 1000
          
          console.info('[HOT_SCREENER_FRONTEND_FRESHNESS]', {
            age_seconds: ageSeconds.toFixed(1),
            coins_count: coins.length,
            strategy: currentStrategy
          })
          
          if (ageSeconds > 60) {
            console.warn('[HOT_SCREENER_FRONTEND_STALE_DATA]', {
              age_seconds: ageSeconds.toFixed(1),
              recommendation: 'Consider refreshing data before calling GPT'
            })
          }
        }
      }
      
      const input = {
        coins,
        strategy: currentStrategy
      }

      const hsBody = JSON.stringify(input)
      const res = await fetch('/api/hot_screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: hsBody
      })
      try { setAiHotScreenerBody(hsBody) } catch {}

      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          if (j && typeof j === 'object') {
            const detail = (j?.meta?.http_error || j?.error || j?.message || j?.code)
            const httpStatus = (j?.meta?.http_status || res.status)
            msg = detail ? String(detail) : `HTTP ${httpStatus}`
          }
        } catch {}
        throw new Error(msg)
      }

      const result = await res.json()
      
      if (!result.ok) {
        throw new Error(result.code || 'Unknown error')
      }

      let hotPicks = result.data.hot_picks || []
      // Strict: filter picks to those present in provided coins universe to avoid invalid symbols (e.g., "MUSDT")
      try {
        const available = new Set<string>((Array.isArray(coins) ? coins : []).map((c:any) => String(c?.symbol || '')))
        const before = hotPicks.length
        hotPicks = hotPicks.filter((p:any) => available.has(String(p?.symbol || '')))
        const removed = before - hotPicks.length
        if (removed > 0) console.warn('[HOT_PICKS_FILTERED_INVALID]', { removed })
      } catch {}
      setHotPicks(hotPicks)
      
      // Auto-select pouze "🟢 Super Hot" picks, ale vynecháme symboly,
      // které mají otevřené pozice nebo čekající objednávky (duplicitní analýza nechceme)
      const isSuperHotRating = (rating: string): boolean => {
        const raw = String(rating || '')
        const lower = raw.toLowerCase()
        // Tolerantní detekce: emoji i čistý text, různé mezery/příp. lokalizace
        return raw.includes('🟢') || lower.includes('super hot') || lower.includes('super A0hot') || lower.replace(/\s+/g, ' ').includes('super hot')
      }
      const superHotSymbols: string[] = hotPicks
        .filter((pick: any) => isSuperHotRating(pick.rating))
        .map((pick: any) => String(pick.symbol || ''))
        .filter(Boolean)
        .filter((sym: string) => {
          const s = String(sym || '').toUpperCase()
          return s !== 'BTCUSDT' && s !== 'ETHUSDT'
        })

      const normalize = (s: string): string => {
        try { return String(s || '').toUpperCase().replace('/', '') } catch { return s }
      }
      const getBlockedSymbols = async (): Promise<Set<string>> => {
        const blocked = new Set<string>()
        // Consolidated endpoint returns 200 and empty arrays when WS user-data is not ready
        const res = await fetchWithRetry('/api/orders_console')
        if (!res.ok) {
          // Do not fail the whole flow – just treat as empty
          return blocked
        }
        const j: any = await res.json()
        const oList = Array.isArray(j?.open_orders) ? j.open_orders : []
        for (const o of oList) {
          const sym = normalize(String(o?.symbol || ''))
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
          const type = String((o as any)?.type || '')
          const isEntryType = ['LIMIT','STOP','STOP_MARKET','STOP_LIMIT'].includes(type.toUpperCase())
          // Support both V2 (e_*) and V3 (sv2_e_*) clientOrderId prefixes
          const isInternalEntry = /^(?:sv2_)?(?:e_l_|e_stl_|e_stm_|e_m_)/.test(clientId)
          // Block ANY internal ENTRY (both BUY/SELL) that is active (not reduceOnly/closePosition)
          if (sym && isEntryType && isInternalEntry && !(reduceOnly || closePosition)) blocked.add(sym)
        }
        const pList = Array.isArray(j?.positions) ? j.positions : []
        for (const p of pList) {
          const size = Number(p?.size)
          const sym = normalize(String(p?.symbol || ''))
          if (sym && Number.isFinite(size) && size > 0) blocked.add(sym)
        }
        return blocked
      }
      try {
        const blocked = await getBlockedSymbols()
        // STRICT: Auto-select pouze Super Hot, které nejsou v open orders ani v otevřených pozicích
        const notBlocked = superHotSymbols.filter(sym => !blocked.has(normalize(sym)))
        setSelectedHotSymbols(notBlocked)
        setBlockedSymbols(Array.from(blocked))
      } catch {
        // Na chybě block-checku zachovej výběr Super Hot, ale bez blocked značek
        setSelectedHotSymbols(superHotSymbols)
        setBlockedSymbols([])
      }
      
      setHotScreenerStatus('success')
    } catch (e: any) {
      setError(`Hot screener error: ${e?.message || 'unknown'}`)
      setHotScreenerStatus('error')
    }
  }

  const runEntryAnalysis = async (symbolsOverride?: string[]) => {
    // 0) Start from currently selected or passed-in
    let baseList = Array.isArray(symbolsOverride) && symbolsOverride.length > 0 ? symbolsOverride : selectedHotSymbols
    if (baseList.length === 0) return

    // Reset AI Entry payload history to avoid mixing runs
    try { setAiEntryBodies([]) } catch {}

    // 0.1) Fresh block-check: před analýzou vyřaď symboly, které už mají otevřené orders/pozice
    try {
      const normalizeLocal = (s: string): string => {
        try { return String(s || '').toUpperCase().replace('/', '') } catch { return s }
      }
      const res = await fetchWithRetry('/api/orders_console')
      if (res.ok) {
        const j: any = await res.json()
        const blocked = new Set<string>()
        const oList = Array.isArray(j?.open_orders) ? j.open_orders : []
        for (const o of oList) {
          const sym = normalizeLocal(String(o?.symbol || ''))
          const reduceOnly = Boolean(o?.reduceOnly)
          const closePosition = Boolean(o?.closePosition)
          const clientId = String((o as any)?.clientOrderId || (o as any)?.C || (o as any)?.c || '')
          const type = String((o as any)?.type || '')
          const isEntryType = ['LIMIT','STOP','STOP_MARKET','STOP_LIMIT'].includes(type.toUpperCase())
          // Support both V2 (e_*) and V3 (sv2_e_*) clientOrderId prefixes
          const isInternalEntry = /^(?:sv2_)?(?:e_l_|e_stl_|e_stm_|e_m_)/.test(clientId)
          // Block ANY internal ENTRY (both BUY/SELL) that is active (not reduceOnly/closePosition)
          if (sym && isEntryType && isInternalEntry && !(reduceOnly || closePosition)) blocked.add(sym)
        }
        const pList = Array.isArray(j?.positions) ? j.positions : []
        for (const p of pList) {
          const size = Number(p?.size)
          const sym = normalizeLocal(String(p?.symbol || ''))
          if (sym && Number.isFinite(size) && size > 0) blocked.add(sym)
        }
        const filtered = baseList.filter(sym => !blocked.has(normalizeLocal(sym)))
        if (filtered.length !== baseList.length) {
          // Aktualizuj výběr na UI, aby se uživatelovi nevracely blokované symboly
          setSelectedHotSymbols(filtered)
          setBlockedSymbols(Array.from(blocked))
        }
        baseList = filtered
        if (baseList.length === 0) return
      }
    } catch {}

    setEntryControlsStatus('loading')
    setEntryStrategies([])
    setCoinControls([])

    try {
      const strategies: EntryStrategyData[] = []
      const payloadsToCopy: Array<{ symbol: string; asset_data: any }> = []
      const priceMap: Record<string, number> = {}
      const failed: string[] = []
      const assetDataBySymbol: Record<string, any> = {}  // Local cache for Risk Manager
      
      const symbols = [...baseList]
      // Stabilizace: nižší paralelismus (omezíme front-end concurrency)
      const limit = 4
      let idx = 0

      const worker = async () => {
        while (idx < symbols.length) {
          const current = symbols[idx++]
          try {
            const assetRes = await fetchWithRetry(`/api/intraday_any?symbol=${encodeURIComponent(current)}`)
            if (!assetRes.ok) { failed.push(current); continue }
            const assetData = await assetRes.json()
            const assets = Array.isArray(assetData?.assets) ? assetData.assets : []
            const asset = assets.find((a: any) => a?.symbol === current)
            if (!asset) { failed.push(current); continue }
            payloadsToCopy.push({ symbol: current, asset_data: asset })
            try { const p = Number(asset?.price); if (Number.isFinite(p) && p > 0) priceMap[current] = p } catch {}
            // Store asset_data both in state and local cache for immediate Risk Manager access
            assetDataBySymbol[current] = asset
            setEntryInputsBySymbol(prev => ({ ...prev, [current]: { symbol: current, asset_data: asset } }))

            const controller = new AbortController()
            // Prodloužit timeout: 180s kvůli špičkám zatížení a velikosti payloadů
            const timeout = window.setTimeout(() => controller.abort(), 180000)
            const entryBody = JSON.stringify({ symbol: current, asset_data: asset, side: 'SHORT' })
            const strategyRes = await fetch('/api/entry_strategy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: entryBody,
              signal: controller.signal
            }).catch((e:any)=>{
              // Map abort to non-ok shape
              return { ok: false, status: 0, json: async ()=>({ ok: false }) } as any
            })
            clearTimeout(timeout)
            try { setAiEntryBodies(prev => [{ symbol: current, body: entryBody, sentAt: new Date().toISOString() }, ...prev].slice(0, 50)) } catch {}
            if (!strategyRes || !(strategyRes as any).ok) {
              try {
                const code = strategyRes ? String(strategyRes.status) : 'no_response'
                ;(window as any).__entry_failed_reasons = Object.assign((window as any).__entry_failed_reasons || {}, { [current]: code })
              } catch {}
              failed.push(current); continue
            }
            const strategyResult = await (strategyRes as any).json()
            if (strategyResult.ok && strategyResult.data) {
              console.log('[ENTRY_STRATEGY_UI_SUCCESS]', { 
                symbol: current, 
                data: strategyResult.data,
                conservative: strategyResult.data?.conservative,
                aggressive: strategyResult.data?.aggressive
              })
              strategies.push(strategyResult.data)
            } else { 
              console.error('[ENTRY_STRATEGY_UI_FAIL]', { symbol: current, result: strategyResult })
              try {
                const code = String(strategyResult?.code || 'unknown')
                ;(window as any).__entry_failed_reasons = Object.assign((window as any).__entry_failed_reasons || {}, { [current]: code })
              } catch {}
              failed.push(current) 
            }
          } catch {
            failed.push(current)
          }
        }
      }

      const workers = Array.from({ length: Math.min(limit, symbols.length) }, () => worker())
      await Promise.all(workers)

      // Auto-copy exact payloads that are sent to /api/entry_strategy
      {
        const text = payloadsToCopy.length ? JSON.stringify(payloadsToCopy, null, 2) : ''
        if (text) {
          try {
            await writeClipboardSafely(text, { requireFocusForAuto: true })
            setSelectedCopied(true)
            window.setTimeout(()=>setSelectedCopied(false), 1200)
          } catch (e: any) {
            // Auto-flow: když není focus/visible, nevyhazuj chybu – zobraz jen nenarušující info
            if (String(e?.code||e?.message||'').includes('document_not_focused')) {
              console.info('Clipboard skipped: document not focused')
            } else {
              setError(`Clipboard error: ${e?.message || 'write failed'}`)
            }
          }
        }
      }

      setEntryStrategies(strategies)
      // Risk Manager per symbol (after strategies computed)
      let newRiskLocal: Record<string, { decision: 'enter'|'skip'; risk_profile: 'conservative'|'aggressive'|null; prob_success: number|null; conservative_score?: number|null; aggressive_score?: number|null; reasons?: string[] }> = {}
      console.log('[RISK_MANAGER_START]', { strategiesCount: strategies.length, strategies })
      try {
        newRiskLocal = {}
        for (const s of strategies) {
          const cons: any = (s as any).conservative || null
          const aggr: any = (s as any).aggressive || null
          const isPlan = (p: any) => p && typeof p.entry === 'number' && typeof p.sl === 'number'
          
          console.log('[RISK_MANAGER_VALIDATE_PLAN]', { 
            symbol: s.symbol, 
            cons, 
            aggr, 
            consIsValid: isPlan(cons), 
            aggrIsValid: isPlan(aggr) 
          })
          
          // Risk Manager requires at least one valid plan
          if (!isPlan(cons) && !isPlan(aggr)) {
            console.warn('[RISK_MANAGER_SKIP]', { symbol: s.symbol, reason: 'no_valid_plans' })
            continue
          }
          
          // Get asset_data from local cache (immediate access, not from async state)
          const assetData = assetDataBySymbol[s.symbol] || null
          
          const toTp = (p: any) => {
            const tps: Array<{ tag: 'tp1'|'tp2'|'tp3'; price: number; allocation_pct: number }> = []
            const tp1 = Number(p?.tp1)
            const tp2 = Number(p?.tp2)
            const tp3 = Number(p?.tp3)
            const has1 = Number.isFinite(tp1) && tp1 > 0
            const has2 = Number.isFinite(tp2) && tp2 > 0
            const has3 = Number.isFinite(tp3) && tp3 > 0
            const count = (has1?1:0) + (has2?1:0) + (has3?1:0)
            if (count === 3) {
              tps.push({ tag: 'tp1', price: tp1, allocation_pct: 0.30 })
              tps.push({ tag: 'tp2', price: tp2, allocation_pct: 0.40 })
              tps.push({ tag: 'tp3', price: tp3, allocation_pct: 0.30 })
            } else if (count === 2) {
              const pairs: Array<['tp1'|'tp2'|'tp3', number]> = []
              if (has1) pairs.push(['tp1', tp1])
              if (has2) pairs.push(['tp2', tp2])
              if (has3) pairs.push(['tp3', tp3])
              for (const [tag, price] of pairs) tps.push({ tag, price, allocation_pct: 0.50 })
            } else if (count === 1) {
              const single = has1 ? ['tp1', tp1] : has2 ? ['tp2', tp2] : ['tp3', tp3]
              tps.push({ tag: single[0] as any, price: single[1] as number, allocation_pct: 1.00 })
            }
            return tps
          }
          
          // Build candidates array with BOTH plans (if available)
          const candidates: any[] = []
          if (isPlan(cons)) {
            candidates.push({ style: 'conservative', entry: cons.entry, sl: cons.sl, tp_levels: toTp(cons), reasoning: cons.reasoning || '' })
          }
          if (isPlan(aggr)) {
            candidates.push({ style: 'aggressive', entry: aggr.entry, sl: aggr.sl, tp_levels: toTp(aggr), reasoning: aggr.reasoning || '' })
          }
          
          const payload: any = {
            symbol: s.symbol,
            posture: (decision?.flag as any) || 'OK',
            candidates,
            asset_data: assetData  // Include full market context (ATR, EMA, RSI, VWAP, support/resistance, liquidity)
          }
          console.log('[RISK_MANAGER_PAYLOAD]', { symbol: s.symbol, candidatesCount: candidates.length, hasAssetData: !!assetData, payload })
          try {
            console.log('[RISK_MANAGER_REQUEST]', { symbol: s.symbol, payload })
            const r = await fetchWithRetry('/api/entry_risk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
            console.log('[RISK_MANAGER_RESPONSE_STATUS]', { symbol: s.symbol, ok: r.ok, status: r.status })
            if (r.ok) {
              const j = await r.json()
              console.log('[RISK_MANAGER_DATA]', { symbol: s.symbol, response: j })
              const d = j?.data || j
              const sym = String(d?.symbol || s.symbol)
              newRiskLocal[sym] = { decision: (d?.decision || 'skip'), risk_profile: (d?.risk_profile || null), prob_success: Number(d?.prob_success ?? null), conservative_score: Number(d?.conservative_score ?? null), aggressive_score: Number(d?.aggressive_score ?? null), reasons: Array.isArray(d?.reasons) ? d.reasons : [] }
              console.log('[RISK_MANAGER_STORED]', { symbol: sym, risk: newRiskLocal[sym] })
              // Update risk badge on strategy list
              setEntryStrategies(prev => prev.map(es => es.symbol === sym ? ({ ...es, risk_profile: (d?.risk_profile || null) as any, confidence: Number(d?.prob_success ?? 0) || undefined }) : es))
              // Auto preselect winner if decision is enter
              if (d?.decision === 'enter' && (d?.risk_profile === 'conservative' || d?.risk_profile === 'aggressive')) {
                setCoinControls(prev => prev.map(c => c.symbol === sym ? ({ ...c, strategy: d.risk_profile as any }) : c))
              }
            } else {
              console.error('[RISK_MANAGER_ERROR]', { symbol: s.symbol, status: r.status })
            }
          } catch (e) {
            console.error('[RISK_MANAGER_EXCEPTION]', { symbol: s.symbol, error: e })
          }
        }
        if (Object.keys(newRiskLocal).length) {
          console.log('[RISK_MANAGER_FINAL]', { totalRisks: Object.keys(newRiskLocal).length, data: newRiskLocal })
          const merged = { ...riskBySymbolRef.current, ...newRiskLocal }
          riskBySymbolRef.current = merged
          setRiskBySymbol(merged)
        }
      } catch (e) {
        console.error('[RISK_MANAGER_MAIN_ERROR]', e)
      }
      setCurrentPrices(priceMap)

      // Initialize coin controls without any locked values – purely display and switches
      const controls: CoinControl[] = strategies.map(strategy => {
        // Prefer explicit Risk Manager choice if available (and decision === 'enter').
        const prof: 'conservative' | 'aggressive' = (() => {
          const r = (newRiskLocal as any)?.[strategy.symbol]
          if (r && r.decision === 'enter' && (r.risk_profile === 'aggressive' || r.risk_profile === 'conservative')) {
            return r.risk_profile as 'conservative' | 'aggressive'
          }
          // Fallback: choose by higher score; then by strategy.risk_profile; finally defaultPreset
          const consScore = Number((strategy as any)?.conservative_score)
          const aggrScore = Number((strategy as any)?.aggressive_score)
          if (Number.isFinite(consScore) && Number.isFinite(aggrScore)) {
            return aggrScore > consScore ? 'aggressive' : 'conservative'
          }
          const rp = (strategy as any)?.risk_profile
          if (rp === 'aggressive' || rp === 'conservative') return rp as 'conservative' | 'aggressive'
          return defaultPreset
        })()
        // TP level must strictly follow header preselection; no auto-picking or fallbacks
        return {
          symbol: strategy.symbol,
          include: true,
          side: defaultSide,
          strategy: prof,
          tpLevel: defaultTPLevel,
          orderType: prof === 'conservative' ? 'limit' : 'stop_limit',
          amount: defaultAmount,
          leverage: defaultLeverage,
          useCustomBuffer: false,
        }
      })

      setCoinControls(controls)
      setEntryControlsStatus('success')
      // Ulož seznam failnutých pro zobrazení v EntryControls
      ;(window as any).__entry_failed_symbols = failed
      setFailedSymbols(failed)
    } catch (e: any) {
      setError(`Entry analysis error: ${e?.message || 'unknown'}`)
      setEntryControlsStatus('error')
    }
  }

  // One-click retry for last failed symbols
  const retryFailed = async () => {
    if (!failedSymbols || failedSymbols.length === 0) return
    await runEntryAnalysis(failedSymbols)
  }

  // Disable auto re-lock: once locked, keep values until user explicitly changes strategy or relocks
  // (No useEffect that overwrites lockedValues on entryStrategies update)

  // Auto-spuštění Entry Analysis: DISABLED – pouze checkbox Auto Prepare v EntryControls může spouštět automaticky přípravu objednávek
  const lastAutoAnalyzeKeyRef = useRef<string>('')
  useEffect(() => { /* disabled per request */ }, [hotScreenerStatus, selectedHotSymbols])

  const handleCoinControlChange = (symbol: string, updates: Partial<CoinControl>) => {
    setCoinControls(prev => prev.map(control => 
      control.symbol === symbol 
        ? { ...control, ...updates }
        : control
    ))
  }

  // Keep per-coin tpLevel in sync with header selection (pre-run preference)
  useEffect(() => {
    // Do not mutate while placing orders
    if (placingOrders) return
    setCoinControls(prev => prev.map(c => ({ ...c, tpLevel: defaultTPLevel })))
  }, [defaultTPLevel, placingOrders])

  // Sync invested amount with header selection prior to placing orders
  useEffect(() => {
    if (placingOrders) return
    setCoinControls(prev => prev.map(c => ({ ...c, amount: defaultAmount })))
  }, [defaultAmount, placingOrders])

  // Sync leverage with header selection prior to placing orders
  useEffect(() => {
    if (placingOrders) return
    setCoinControls(prev => prev.map(c => ({ ...c, leverage: defaultLeverage })))
  }, [defaultLeverage, placingOrders])

  // Sync side with header selection prior to placing orders
  useEffect(() => {
    if (placingOrders) return
    setCoinControls(prev => prev.map(c => ({ ...c, side: defaultSide })))
  }, [defaultSide, placingOrders])

  const prepareOrders = async () => {
    console.log('[PREPARE_ORDERS_START]', { 
      coinControlsLength: coinControls.length, 
      riskBySymbolKeys: Object.keys(riskBySymbolRef.current),
      riskData: riskBySymbolRef.current
    })
    try {
      setPlacingOrders(true)
      setError(null)
      const includedControls = coinControls.filter(c => c.include)
      console.log('[PREPARE_ORDERS_INCLUDED]', { 
        includedCount: includedControls.length, 
        symbols: includedControls.map(c => c.symbol) 
      })
      // Risk gate: povol pouze GO (decision==='enter'); NO-GO nikdy neposílej
      // Debug: uložit riskBySymbol do global scope
      // CRITICAL FIX: Use ref instead of state to get latest risk decisions (state update is async!)
      const currentRisk = riskBySymbolRef.current;
      (window as any).__risk_by_symbol_debug = currentRisk;
      
      const goControls = includedControls.filter(c => {
        const decision = currentRisk?.[c.symbol]?.decision;
        console.log(`[RISK_CHECK] ${c.symbol}: decision="${decision}", isEnter=${decision === 'enter'}`);
        try { return decision === 'enter' } catch { return false }
      })
      const noGoControls = includedControls.filter(c => {
        try { return currentRisk?.[c.symbol]?.decision === 'skip' } catch { return false }
      })
      console.log('[RISK_GATE]', {
        selected: includedControls.map(c => c.symbol),
        go: goControls.map(c => c.symbol),
        nogo: noGoControls.map(c => c.symbol),
        riskBySymbol: currentRisk,
        detailedCheck: includedControls.map(c => ({
          symbol: c.symbol,
          riskDecision: currentRisk?.[c.symbol]?.decision,
          willSend: currentRisk?.[c.symbol]?.decision === 'enter'
        }))
      })
      console.warn('[RISK_GATE_GO_COUNT]', { goCount: goControls.length, totalSelected: includedControls.length })
      
      // CRITICAL DEBUG ALERT
      const debugMsg = `
🔍 RISK GATE DEBUG:
━━━━━━━━━━━━━━━━━━
Selected: ${includedControls.length} coins
GO (enter): ${goControls.length} coins
NO-GO (skip): ${noGoControls.length} coins

Risk Data:
${includedControls.map(c => {
  const dec = currentRisk?.[c.symbol]?.decision;
  return `${c.symbol}: ${dec || 'MISSING'}`;
}).join('\n')}

${goControls.length === 0 ? '❌ NO COINS TO SEND!' : '✅ Will send ' + goControls.length + ' orders'}
      `.trim();
      
      console.log(debugMsg);
      
      if (noGoControls.length > 0) {
        console.warn('[NO_GO_SKIPPED]', noGoControls.map(c => c.symbol))
      }
      if (goControls.length === 0) {
        setPlacingOrders(false)
        // NO-GO modal removed - info is in console and UI banner
        setError('All selected coins are NO-GO or missing risk decision')
        return
      }
      
      // Partial NO-GO - info is in console, no modal needed
      if (goControls.length > 0 && goControls.length < includedControls.length) {
        console.warn('[PARTIAL_NO_GO]', { sent: goControls.length, skipped: noGoControls.length })
      }
      if (includedControls.length === 0) { setError('No coins selected'); return }
      // Pre-validate against MARK price (fail-fast: 5s timeout; server vynutí MARK guard tak jako tak)
      const getMark = async (s: string): Promise<number|null> => {
        const ac = new AbortController()
        const timeoutMs = 5000
        const to = window.setTimeout(() => {
          try { ac.abort(new DOMException(`timeout after ${timeoutMs}ms`, 'TimeoutError')) } catch { ac.abort() }
        }, timeoutMs)
        try {
          const r = await fetch(`/api/mark?symbol=${encodeURIComponent(s)}`, { signal: ac.signal })
          if (!r.ok) return null
          const j = await r.json().catch(()=>null)
          return Number(j?.mark)
        } catch { return null } finally { clearTimeout(to) }
      }
      // Map selected plan to numeric entry/SL/TP with strict risk gate
      const findPlan = (symbol: string, strategy: 'conservative'|'aggressive') => {
        const s = entryStrategies.find(es => es.symbol === symbol)
        if (!s) return null
        return strategy === 'conservative' ? s.conservative : s.aggressive
      }
      // DEBUG: MEGA AUDIT všech dat před odesláním
      console.log('[MEGA_DEBUG_START] ===== AUDIT PŘED ODESLÁNÍM =====')
      console.log('[ENTRY_STRATEGIES_FULL]', entryStrategies)
      console.log('[COIN_CONTROLS_FULL]', coinControls)
      console.log('[INCLUDED_CONTROLS]', includedControls)
      for (const c of goControls) {
        const strategy = entryStrategies.find(es => es.symbol === c.symbol)
        console.log('[CONTROL_VS_STRATEGY]', { 
          symbol: c.symbol, 
          strategy: c.strategy, 
          tpLevel: c.tpLevel,
          control_data: c,
          found_strategy: strategy || null,
          conservative_plan: strategy?.conservative || null,
          aggressive_plan: strategy?.aggressive || null
        })
      }
      
      // ŽÁDNÉ LOCKED VALUES – použij přesně numbers z entryStrategies (strategie/plan)
      // Vyloučit symboly, které nejsou zaškrtnuté. Dedup by symbol.
      // Přísná kontrola: povol pouze symboly, které mají platný plán (entry/sl/tpX)
      const controlsWithPlan = (() => {
        const missing: string[] = []
        const ok = goControls.filter(c => {
          const s = entryStrategies.find(es => es.symbol === c.symbol)
          const plan = s ? (c.strategy === 'conservative' ? (s as any).conservative : (s as any).aggressive) : null
          if (!plan) { missing.push(c.symbol); return false }
          const tpKey = c.tpLevel as 'tp1'|'tp2'|'tp3'
          const hasEntrySl = typeof (plan as any).entry === 'number' && typeof (plan as any).sl === 'number'
          const hasTpKey = typeof (plan as any)[tpKey] === 'number'
          if (!hasEntrySl) { missing.push(c.symbol); return false }
          if (!hasTpKey) {
            // allow proceed; TP pro zvolenou úroveň chybí – nezobrazíme map payloadu
            return true
          }
          return true
        })
        if (missing.length) {
          try { setError(`Missing strategy plan for: ${Array.from(new Set(missing)).join(', ')}`) } catch {}
        }
        return ok
      })()

      console.log('[MAP_START]', { controlsWithPlanCount: controlsWithPlan.length, symbols: controlsWithPlan.map(c => c.symbol) })
      const mapped = controlsWithPlan.map((c, idx) => {
        try {
          console.log('[MAP_ITEM_START]', { index: idx, symbol: c.symbol, total: controlsWithPlan.length })
          const plan = findPlan(c.symbol, c.strategy) as any
          const entry = Number(plan.entry)
          const sl = Number(plan.sl)
          const tpKey = c.tpLevel as 'tp1' | 'tp2' | 'tp3'
          const tpValRaw = (plan as any)[tpKey]
          const tpVal = Number(tpValRaw)
          console.log('[UI_ORDER_MAP]', { symbol: c.symbol, strategy: c.strategy, tpLevel: c.tpLevel, plan: { entry, sl, tp: tpVal } })
          console.log('[UI_PAYLOAD_VS_DISPLAY]', JSON.stringify({ symbol: c.symbol, payload: { entry, sl, tp: tpVal }, note: 'Check if this matches UI display' }, null, 2))

          const result = {
            symbol: c.symbol,
            side: (() => {
              if (!c.side) throw new Error(`Missing side for ${c.symbol}`)
              return c.side as any
            })(),
            strategy: c.strategy,
            tpLevel: c.tpLevel,
            orderType: c.orderType || (c.strategy === 'conservative' ? 'limit' : 'stop_limit'),
            amount: c.amount,
            leverage: c.leverage,
            risk_label: String((plan as any)?.risk || ''),
            entry,
            sl,
            tp: tpVal,
            universe: c.strategy  // Přidáno: sledování universe zdroje
          }
          console.log('[MAP_ITEM_SUCCESS]', { index: idx, symbol: c.symbol })
          return result
        } catch (e: any) {
          console.error('[MAP_ITEM_ERROR]', { index: idx, symbol: c.symbol, error: e.message, stack: e.stack })
          throw e
        }
      })
      console.log('[MAP_COMPLETE]', { mappedCount: mapped.length })

      // Validate numeric fields; drop invalid symbols but continue with the rest
      {
        const bad: string[] = []
        const valid: typeof mapped = []
        for (const o of mapped) {
          const okEntry = (typeof o.entry === 'number' && Number.isFinite(o.entry) && o.entry > 0)
          const okSL = (typeof o.sl === 'number' && Number.isFinite(o.sl) && o.sl > 0)
          const okTP = (typeof o.tp === 'number' && Number.isFinite(o.tp) && o.tp > 0)
          if (okEntry && okSL && okTP) valid.push(o)
          else {
            const miss: string[] = []
            if (!okEntry) miss.push('ENTRY')
            if (!okSL) miss.push('SL')
            if (!okTP) miss.push('TP')
            bad.push(`${o.symbol}: missing ${miss.join(', ')}`)
          }
        }
        if (bad.length) {
          setError(`Missing numeric values – some symbols skipped.\n${bad.join('\n')}`)
        }
        if (valid.length === 0) {
          setPlacingOrders(false)
          return
        }
        // Continue with only valid orders
        mapped.splice(0, mapped.length, ...valid)
      }
      // STRICT 1:1 preflight – ověř, že klient posílá přesně čísla z aktuálního plánu (zobrazeného v UI)
      // Nezastavuj odeslání při drobných odchylkách; pouze varuj a pokračuj s UI hodnotami 1:1
      {
        const diffs: string[] = []
        for (const c of goControls) {
          const plan = findPlan(c.symbol, c.strategy)
          if (!plan) continue
          const expEntry = Number((plan as any).entry) || 0
          const expSL = Number((plan as any).sl) || 0
          const expTP = Number((plan as any)[c.tpLevel]) || 0
          const got = mapped.find(m => m.symbol === c.symbol)
          if (!got) continue
          const add = (label: string, exp: any, val: any) => {
            const ex = Number(exp); const va = Number(val)
            if (!(Number.isFinite(ex) && Number.isFinite(va))) return
            if (Math.abs(ex - va) > 1e-12) diffs.push(`${c.symbol} ${label}: expected ${ex} from GPT, got ${va}`)
          }
          add('ENTRY', expEntry, got.entry)
          add('SL', expSL, got.sl)
          add(String(c.tpLevel).toUpperCase(), expTP, got.tp)
        }
        if (diffs.length > 0) {
          // Pouze informuj; odeslání pokračuje s UI přenesenými hodnotami
          setError(`STRICT 1:1: Mismatch detekován – pokračuji s UI čísly.\n${diffs.join('\n')}`)
        }
      }
      const uniqMap = new Map<string, any>()
      for (const o of mapped) uniqMap.set(o.symbol, o)
      let orders = Array.from(uniqMap.values())
      console.log('[MARK_VALIDATION_START]', { ordersCount: orders.length, symbols: orders.map(o => o.symbol) })
      // MARK guards (client-side): pokračuj s validními, chybné vypiš
      const invalid: string[] = []
      const invalidSymbols = new Set<string>()
      for (const o of orders) {
        console.log('[GET_MARK_START]', { symbol: o.symbol })
        const mark = await getMark(o.symbol)
        console.log('[GET_MARK_RESULT]', { symbol: o.symbol, mark })
        if (!Number.isFinite(mark as any)) continue
        if (!o.side) throw new Error(`Missing side for ${o.symbol}`)
        // SHORT system - validate SHORT prices
        const sideShort = o.side === 'SHORT'
        if (sideShort) {
          if (o.tp && !(o.tp < (mark as number))) { invalid.push(`${o.symbol}: TP ${o.tp} ≥ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
          if (o.sl && !(o.sl > (mark as number))) { invalid.push(`${o.symbol}: SL ${o.sl} ≤ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
        } else {
          if (o.tp && !(o.tp < (mark as number))) { invalid.push(`${o.symbol}: TP ${o.tp} ≥ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
          if (o.sl && !(o.sl > (mark as number))) { invalid.push(`${o.symbol}: SL ${o.sl} ≤ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
        }
      }
      console.log('[MARK_VALIDATION_DONE]', { invalidCount: invalid.length, validCount: orders.length - invalidSymbols.size })
      if (invalid.length) {
        // Only warn; do NOT filter out orders. Server enforces MARK guards strictly.
        setError(`Upozornění (MARK guard klient):\n${invalid.join('\n')}\nObjednávky odeslány – server zvaliduje přesně.`)
      }
      if (orders.length === 0) return
      
      console.log('[ROUTING_DECISION]', { useTemporalEntry, useAutoCopy, ordersCount: orders.length })
      if (useTemporalEntry) {
        if (useAutoCopy) {
          // Guard: if Auto Copy already running (known ID or discoverable), do NOT start again
          if (autoCopyId) {
            console.log('[AUTO_COPY_ALREADY_RUNNING]', { workflowId: autoCopyId })
            return
          }
          try {
            const chk = await fetch('/api/temporal/auto_copy/active')
            if (chk.ok) {
              const j = await chk.json()
              const wid = j?.workflowId || null
              if (wid) {
                setAutoCopyId(wid)
                try { localStorage.setItem('auto_copy_wf_id', wid) } catch {}
                console.log('[AUTO_COPY_ATTACHED_TO_EXISTING]', { workflowId: wid })
                return
              }
            }
          } catch {}
          // Start Auto Copy workflow (headless, durable timers)
          const items = orders.map(o => ({
            symbol: o.symbol,
            side: o.side,
            strategy: o.strategy,
            amountUsd: o.amount,
            leverage: o.leverage,
            orderType: o.orderType,
            entry: o.entry,
            sl: o.sl,
            tp: o.tp,
            riskApproved: true,
            skipAi: true
          }))
          // Interval minutes are sourced from header's localStorage to ensure UI controls drive WF
          const minutesRaw = localStorage.getItem('auto_copy_minutes') ?? String(autoCopyIntervalMin)
          const minutes = (()=>{ const n = Number(minutesRaw); return Number.isFinite(n) && n > 0 ? Math.floor(n) : autoCopyIntervalMin })()
          const req = { workflowId: 'auto_copy_main_v3', intervalMinutes: minutes, maxRounds: null, items }
          const resp = await fetch('/api/temporal/auto_copy/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
          const j = await resp.json().catch(()=>({ ok: false }))
          if (!resp.ok || !j?.ok) {
            const msg = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${resp.status}`
            throw new Error(`Auto Copy start failed: ${msg}`)
          }
          const wfId = String(j?.workflowId || '')
          setAutoCopyId(wfId)
          try { localStorage.setItem('auto_copy_wf_id', wfId) } catch {}
          console.log('[AUTO_COPY_STARTED]', { workflowId: wfId })
        } else {
          // Start Temporal EntryAssistant workflows in batch (headless)
          const payloads = orders.map(o => ({
            symbol: o.symbol,
            side: o.side,
            strategy: o.strategy,
            amountUsd: o.amount,
            leverage: o.leverage,
            orderType: o.orderType,
            entry: o.entry,
            sl: o.sl,
            tp: o.tp,
            riskApproved: (() => { try { return (riskBySymbol as any)?.[o.symbol]?.decision === 'enter' } catch { return false } })(),
            skipAi: true
          }))
          console.log('[TEMPORAL_ENTRY_START_BATCH]', { count: payloads.length, payloads })
          const resp = await fetch('/api/temporal/entry/start_batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloads)
          })
          const j = await resp.json().catch(()=>({ ok: false }))
          if (!resp.ok || !j?.ok) {
            const msg = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${resp.status}`
            throw new Error(`Temporal start_batch failed: ${msg}`)
          }
          const okCount = Array.isArray(j?.results) ? j.results.filter((r:any)=>r?.ok).length : 0
          console.log('[TEMPORAL_ENTRY_STARTED]', { okCount, total: payloads.length, results: j?.results })
        }
      } else {
        // Legacy direct place_orders flow
        console.log('[PLACE_ORDERS_REQUEST]', { count: orders.length, orders })
        const resp = await fetch('/api/place_orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders })
        })
        let j: any = null
        try { j = await resp.json() } catch { /* ignore */ }
        if (!resp.ok || (j && j.success === false)) {
          const msg = (j && (j.error || j.message)) ? (j.error || j.message) : `HTTP ${resp.status}`
          throw new Error(`Place orders failed: ${msg}`)
        }
        console.log('[PLACE_ORDERS_DONE]', { ok: true, executed: Array.isArray(j?.orders) ? j.orders.length : undefined })
      }
    } catch (e: any) {
      setError(`Order submit error: ${e?.message || 'unknown'}`)
    } finally {
      setPlacingOrders(false)
    }
  }

  // WS health poll (best-effort)
  // WS health poll disabled in production to minimize requests
  useEffect(() => { /* disabled */ }, [])

  // No auto-run on load; wait for explicit user click

  useEffect(() => {
    // Disable restore of market pipeline artifacts: always fresh per run
    // Keep only UI telemetry elsewhere
  }, []);

  // Keyboard shortcuts: DISABLED auto-run on 'r' key to prevent accidental runs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable === true || target.tagName === 'SELECT'
      )
      if (isTyping) return
      
      // DISABLED: Auto-run on 'r' key removed per user request
      // if (e.key === 'r' || e.key === 'R') {
      //   if (!running) onRun()
      // } else 
      
      if (e.key === 's' || e.key === 'S') {
        onExport()
      } else if (e.key === 'f' || e.key === 'F') {
        onExportFeatures()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, snapshot, features])

  return (
    <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
      {/* Right-top widgets */}
      {/* Keep widget container but do not overlap older widgets; render lower in DOM flow */}
      <HeaderBar 
        running={running} 
        onRun={onRun} 
        onExportSnapshot={onExport} 
        onExportFeatures={onExportFeatures} 
        onToggleSettings={() => setSettingsOpen(true)} 
        onToggleReport={() => setShowReport(v => !v)} 
        showingReport={showReport} 
        defaultPreset={defaultPreset} 
        onChangeDefaultPreset={(p)=>setDefaultPreset(p)}
        defaultSide={defaultSide}
        onChangeDefaultSide={(s)=>setDefaultSide(s)}
        defaultTPLevel={defaultTPLevel}
        onChangeDefaultTPLevel={(t)=>setDefaultTPLevel(t)}
        defaultAmount={defaultAmount}
        onChangeDefaultAmount={(n)=>setDefaultAmount(Math.max(1, Math.floor(n || 0)))}
        defaultLeverage={defaultLeverage}
        onChangeDefaultLeverage={(n)=>setDefaultLeverage(Math.max(1, Math.floor(n || 0)))}
        selectedUniverses={selectedUniverses}
        onChangeSelectedUniverses={(arr)=>setSelectedUniverses(arr)}
        currentStrategy={selectedUniverses[currentRotationIndex] || 'losers'}
        onCopyRawAll={copyRawAll}
        rawLoading={rawLoading}
        rawCopied={rawCopied}
        count={(displayCoins as any[]).length}
        onToggleAiPayloads={() => setAiShowPanel(v => !v)}
        onTogglePrompts={() => setPromptsOpen(v => !v)}
        onToggleAiOverview={() => { window.open('/#/dev/ai-overview', '_blank') }}
        onAutoCopyRawToggle={(enabled)=>{
          // Toggle pouze připojí/odpojí – žádné mock spouštění
          try {
            if (enabled) {
              // Validate: at least 1 checkbox must be selected
              if (selectedUniverses.length === 0) {
                setError('Musíte vybrat alespoň jednu strategii pro auto režim')
                return
              }
            }
            if (!enabled) {
              if (autoCopyId) {
                fetch('/api/temporal/auto_copy/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: autoCopyId, cmd: 'cancel' }) })
                setAutoCopyId(null)
                setAutoCopyStatus(null)
                try { localStorage.removeItem('auto_copy_wf_id') } catch {}
              }
            } else {
              (async () => {
                try {
                  const activeResp = await fetch('/api/temporal/auto_copy/active')
                  if (activeResp.ok) {
                    const aj = await activeResp.json()
                    if (aj?.workflowId) {
                      setAutoCopyId(aj.workflowId)
                      try { localStorage.setItem('auto_copy_wf_id', aj.workflowId) } catch {}
                    }
                  }
                } catch {}
              })()
            }
          } catch {}
        }}
        serverNextAt={autoCopyStatus?.nextAt ?? null}
      />
      {aiShowPanel && (
        <AiPayloadsPanel
          hsBody={aiHotScreenerBody}
          entryBodies={aiEntryBodies}
          onClose={()=>setAiShowPanel(false)}
        />
      )}
      <PromptsModal 
        isOpen={promptsOpen} 
        onClose={() => setPromptsOpen(false)} 
      />
      {/* Auto Copy status banner */}
      {autoCopyId && (
        <div className="card" style={{ marginTop: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <strong>Auto Copy</strong>
            <span style={{ fontSize: 12, opacity: .9 }}>WF: {autoCopyId}</span>
            {autoCopyStatus ? (
              <span style={{ fontSize: 12, opacity: .9 }}>
                {(() => {
                  try {
                    const ts = autoCopyStatus.nextAt ? Date.parse(autoCopyStatus.nextAt) : 0
                    const runningNow = !autoCopyStatus.nextAt || ts <= Date.now()
                    if (runningNow) return `Running (Round ${autoCopyStatus.round})`
                    const rem = Math.max(0, ts - Date.now())
                    const m = Math.floor(rem / 60000)
                    const s = Math.floor((rem % 60000) / 1000)
                    return `Next in ${String(m).padStart(1,'0')}:${String(s).padStart(2,'0')}`
                  } catch { return '—' }
                })()}
                {autoCopyStatus.paused ? ' (paused)' : ''}
              </span>
            ) : (
              <span style={{ fontSize: 12, opacity: .7 }}>Loading…</span>
            )}
            {autoCopyError ? <span style={{ color: 'crimson', fontSize: 12 }}>{autoCopyError}</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => stopAutoCopy('pause')}>Pause</button>
            <button className="btn" onClick={() => stopAutoCopy('resume')}>Resume</button>
            <button className="btn" onClick={() => stopAutoCopy('cancel')}>Cancel</button>
          </div>
        </div>
      )}
      
      {/* Trading hours widget - top right */}
      <TradingHoursTrafficLight floating={true} />
      
      {/* Fear & Greed widget - below trading hours widget */}
      <div style={{ position: 'fixed', top: 150, right: 8, display: 'flex', gap: 8, zIndex: 1000 }}>
        <FearGreedWidget />
      </div>
      
      {/* Entry Price Multiplier widget - below Fear & Greed */}
      <EntryPriceMultiplierWidget />
      {/* Last results history under WF panel */}
      {autoCopyStatus && (
        <div className="card" style={{ marginTop: 6, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Last Results</strong>
            <span style={{ fontSize: 12, opacity: .8 }}>Round {autoCopyStatus.round}</span>
          </div>
          {Array.isArray((autoCopyStatus as any).lastResults) && (autoCopyStatus as any).lastResults.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 6, marginTop: 6 }}>
              {(autoCopyStatus as any).lastResults.map((r: any, idx: number) => (
                <div key={idx} style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 8, fontSize: 12 }}>
                  <div><strong>{r.symbol || '—'}</strong> • {r.ok ? 'OK' : 'FAIL'}</div>
                  <div style={{ opacity: .85 }}>WF: {r.workflowId || '—'}</div>
                  {r.error ? <div style={{ color: 'crimson' }}>{String(r.error)}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No results yet</div>
          )}
        </div>
      )}
      {false && (
        <div className="card" style={{ marginTop: 8, padding: 12 }}>
          <strong>Active Entries</strong>
          <div style={{ height: 6 }} />
          <ActiveEntriesPanel />
        </div>
      )}
      
      {showReport ? (
        <>
          <ReportView snapshot={snapshot} features={features} decision={decision} signals={signalSet} featuresMs={featuresMs ?? null} />
          <div style={{ height: 8 }} />
          {/* OrdersPanel intentionally rendered only once globally to avoid duplicate polling */}
        </>
      ) : (
        <>
      {decision && (
        <>
          <DecisionBanner 
            decision={decision} 
            rawBtcH1={rawRegime?.btc_h1 ?? null}
            btc={snapshot?.btc}
            eth={snapshot?.eth}
            timestamp={snapshot?.timestamp}
          />
          <div style={{ height: 8 }} />
        </>
      )}
      {/* Snapshot/status UI intentionally hidden */}
      {errorPayload ? <ErrorPanel payload={errorPayload} /> : (error ? <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</pre> : null)}
      <label style={{fontSize:12,opacity:.9,display:'flex',gap:6,alignItems:'center',margin:'8px 0'}}>
        <input type="checkbox" checked={forceCandidates} onChange={e=>setForceCandidates(e.target.checked)} />
        Show candidates even when NO-TRADE (preview)
      </label>
      {snapshot && (
        <details style={{ marginTop: 16 }}>
          <summary>Preview snapshot</summary>
          <pre style={{ maxHeight: 400, overflow: 'auto' }}>
            {JSON.stringify(snapshot, null, 2)}
          </pre>
        </details>
      )}
      {Array.isArray(coinsSource) && (coinsSource as any[]).length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong>Alt universe</strong>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="btn" style={{ border: '2px solid #333' }} onClick={copyRawAll} aria-label="Copy RAW dataset (all alts)" title={rawCopied ? 'Zkopírováno' : 'Copy RAW dataset'} disabled={rawLoading}>
                {rawLoading ? 'Stahuji…' : (rawCopied ? 'RAW zkopírováno ✓' : 'Copy RAW (vše)')}
              </button>
              <button className="btn" style={{ border: '2px solid #333' }} onClick={copySelectedEntryInputs} aria-label="Copy GPT payload (selected)" title={selectedCopied ? 'Zkopírováno' : 'Copy GPT inputs (selected)'}>
                {selectedCopied ? 'Selected zkopírováno ✓' : 'Copy Selected'}
              </button>
            </div>
          </div>
          {/* Per-coin copy buttons below header for clarity */}
          <div className="coins-grid">
            {(displayCoins as any[]).map((u: any, idx: number) => (
              <div key={`${u.symbol}-${idx}`} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, border: '1px solid #2a2a2a', padding: '4px 6px', borderRadius: 6 }}>
                <span style={{ fontSize: 11, opacity: .8 }}>#{idx + 1}</span>
                <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: 13, opacity: .95, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '70%', pointerEvents: 'none' }}>
                  {formatSymbol(u.symbol)}
                </span>
                <button className="btn" onClick={() => copyCoin(String(u.symbol))} aria-label={`Copy ${u.symbol} JSON`} title={copiedSymbol === u.symbol ? 'Zkopírováno' : 'Copy to clipboard'} disabled={loadingSymbol === u.symbol} style={{ padding: '3px 6px', fontSize: 11 }}>
                  {loadingSymbol === u.symbol ? 'Stahuji…' : (copiedSymbol === u.symbol ? '✓' : 'Copy')}
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <textarea
              readOnly
              style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 12 }}
              value={(displayCoins as any[]).map((u: any) => u.symbol).join(', ')}
            />
          </div>
        </div>
      )}
      {features && (
        <>
          <div style={{ height: 8 }} />
          <FeaturesPreview features={features} />
        </>
      )}
      {decision && (
        <>
          {finalPickerStatus === 'error' ? (
            <div className="error" style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>Final Picker selhal (STRICT NO-FALLBACK)</strong>
                <button className="btn" onClick={() => { try { const raw = localStorage.getItem('m4FinalPicker'); if (raw) writeClipboard(raw) } catch {} }}>Copy details</button>
              </div>
              <div style={{ fontSize: 12, opacity: .9, marginTop: 4 }}>Code: {finalPickerMeta?.error_code ?? 'unknown'}</div>
            </div>
          ) : finalPickerStatus === 'success_no_picks' ? (
            <div className="card" style={{ marginTop: 8 }}>Žádné kvalitní setupy (0) pro 60–90 min okno.</div>
          ) : null}
        </>
      )}
      {/* Hot Trading Components */}
      <HotScreener 
        hotPicks={hotPicks}
        status={hotScreenerStatus}
        selectedSymbols={selectedHotSymbols}
        onSelectionChange={setSelectedHotSymbols}
        onAnalyzeSelected={() => runEntryAnalysis()}
        blockedSymbols={blockedSymbols}
        failedSymbols={failedSymbols}
        onRetryFailed={retryFailed}
      />

      {entryControlsStatus !== 'idle' && (
        <EntryControls 
          entryStrategies={entryStrategies}
          coinControls={coinControls}
          onControlChange={handleCoinControlChange}
          status={entryControlsStatus}
          currentPrices={currentPrices}
          globalBuffers={{
            conservative: hotTradingSettings.conservativeBuffer,
            aggressive: hotTradingSettings.aggressiveBuffer
          }}
          maxPerCoin={hotTradingSettings.maxPerCoin}
          maxCoins={hotTradingSettings.maxCoins}
          onPrepareOrders={prepareOrders}
          placing={placingOrders}
          failedSymbols={(window as any).__entry_failed_symbols || []}
          riskDecision={riskBySymbol}
        />
      )}
      {entryStrategies.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => { try { console.log('[ENTRY_STRATEGIES_SHOW]', JSON.stringify(entryStrategies, null, 2)) } catch {} }}>
            Show entryStrategies
          </button>
        </div>
      )}

      {/* Always show candidates table (Alt universe preview) or clear empty-state */}
      {candidates.length > 0 ? (
        <CandidatesPreview list={candidates as any} finalPickerStatus={finalPickerStatus} executionMode={localStorage.getItem('execution_mode') === '1'} />
      ) : (
        <div className="card" style={{ marginTop: 8, fontSize: 12, opacity: .85 }}>
          No candidates – Alt universe pool is empty for current filters/posture.
        </div>
      )}

      {/* Final picks table */}
      {(finalPickerStatus !== 'idle') ? (
        <>
          <div style={{ height: 8 }} />
          <SetupsTable
            finalPicks={finalPicks}
            finalPickerStatus={finalPickerStatus}
            finalPickerMeta={{ latencyMs: finalPickerMeta?.latencyMs ?? null, error_code: finalPickerMeta?.error_code ?? null, error_message: finalPickerMeta?.error_message ?? null, posture: (decision?.flag as any) ?? 'NO-TRADE', candidatesCount: candidates.length, picksCount: finalPicks.length }}
            posture={(decision?.flag as any) ?? 'NO-TRADE'}
            settings={{
              execution_mode: Boolean(localStorage.getItem('execution_mode') === '1'),
              side_policy: ((() => { try { return (localStorage.getItem('side_policy') as any) || 'both' } catch { return 'both' } })() as any),
              max_picks: (() => { try { return Math.max(1, Math.min(6, Number(localStorage.getItem('max_picks')) || 6)) } catch { return 6 } })(),
              preset: ((() => { try { return (localStorage.getItem('preset') as any) || 'Momentum' } catch { return 'Momentum' } })() as any),
              equity_usdt: (() => { try { return Number(localStorage.getItem('equity_usdt')) || 10000 } catch { return 10000 } })(),
              confidence_go_now_threshold: (() => { try { const v = Number(localStorage.getItem('confidence_go_now_threshold') ?? localStorage.getItem('go_now_conf_threshold')); return Number.isFinite(v) && v > 0 ? v : 0.6 } catch { return 0.6 } })(),
              override_no_trade_execution: (() => { try { return (localStorage.getItem('override_no_trade_execution') ?? '0') === '1' } catch { return false } })(),
              override_no_trade_risk_pct: (() => { try { const v = Number(localStorage.getItem('override_no_trade_risk_pct')); return Number.isFinite(v) ? v : 0.10 } catch { return 0.10 } })(),
              no_trade_confidence_floor: (() => { try { const v = Number(localStorage.getItem('no_trade_confidence_floor')); return Number.isFinite(v) ? v : 0.65 } catch { return 0.65 } })(),
              max_leverage: (() => { try { const v = Number(localStorage.getItem('max_leverage')); return Number.isFinite(v) ? v : 20 } catch { return 20 } })(),
            }}
            exchangeFilters={(snapshot as any)?.exchange_filters ?? {}}
            runStartedAt={(runStartedAt ?? (snapshot?.timestamp ? Date.parse(snapshot.timestamp) : Date.now()))}
          />
        </>
      ) : null}
      {/* Orders & Positions overview – single instance */}
      <OrdersPanel />
      {/* OrderDebugFooter disabled temporarily */}
        </>
      )}
      <PnlReportPanel />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} lastSnapshot={snapshot} lastRunAt={lastRunAt} finalPickerStatus={finalPickerStatus} finalPicksCount={finalPicks.length} posture={(decision?.flag as any) ?? 'NO-TRADE'} />
    </div>
  );
};

