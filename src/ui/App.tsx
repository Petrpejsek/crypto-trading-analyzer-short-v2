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
  const [universeStrategy, setUniverseStrategy] = useState<'volume' | 'gainers'>(() => 'gainers');
  const prevStrategyRef = useRef(universeStrategy)
  useEffect(() => {
    if (prevStrategyRef.current !== universeStrategy) {
      setRawCoins(null)
      setRawCoinsTs(null)
      try { localStorage.removeItem('rawCoins') } catch {}
    }
    prevStrategyRef.current = universeStrategy
  }, [universeStrategy])
  const [forceCandidates, setForceCandidates] = useState<boolean>(true);

  // Hot trading state
  const [hotPicks, setHotPicks] = useState<HotPick[]>([])
  const [hotScreenerStatus, setHotScreenerStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [selectedHotSymbols, setSelectedHotSymbols] = useState<string[]>([])
  const [blockedSymbols, setBlockedSymbols] = useState<string[]>([])
  // Store GPT entry inputs per symbol to enable copying selected payloads
  const [entryInputsBySymbol, setEntryInputsBySymbol] = useState<Record<string, { symbol: string; asset_data: any }>>({})
  const [entryStrategies, setEntryStrategies] = useState<EntryStrategyData[]>([])
  const [entryControlsStatus, setEntryControlsStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [coinControls, setCoinControls] = useState<CoinControl[]>([])
  const [currentPrices, setCurrentPrices] = useState<Record<string, number>>({})
  // TODO: future – add markPrice map if needed
  const [placingOrders, setPlacingOrders] = useState(false)
  const [defaultPreset, setDefaultPreset] = useState<'conservative'|'aggressive'>('conservative')

  // Global defaults controlled in HeaderBar
  const [defaultSide, setDefaultSide] = useState<'LONG'|'SHORT'>(() => {
    try {
      const envSide = (import.meta as any)?.env?.VITE_TRADE_SIDE as 'LONG' | 'SHORT' | undefined
      if (envSide === 'SHORT') return 'SHORT'
      const saved = localStorage.getItem('ui_side') as 'LONG' | 'SHORT' | null
      return saved === 'SHORT' ? 'SHORT' : 'SHORT'
    } catch { return 'SHORT' }
  })
  const [defaultTPLevel, setDefaultTPLevel] = useState<'tp1'|'tp2'|'tp3'>('tp2')
  const [defaultAmount, setDefaultAmount] = useState<number>(20)
  const [defaultLeverage, setDefaultLeverage] = useState<number>(15)

  // Load hot trading settings from localStorage
  const hotTradingSettings = useMemo(() => ({
    conservativeBuffer: 0,
    aggressiveBuffer: 0,
    maxPerCoin: 500,
    maxCoins: 5,
    defaultStrategy: 'conservative',
    defaultTPLevel: 'tp2',
    defaultLeverage: 15,
    defaultAmount: 20
  }), [])

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
    const list = Array.isArray(coinsSource) ? [...coinsSource] : []
    const base = (sym: string) => {
      try { return sym.endsWith('USDT') ? sym.slice(0, -4) : sym } catch { return sym }
    }
    list.sort((a: any, b: any) => String(base(a?.symbol || '')).localeCompare(String(base(b?.symbol || ''))))
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
        const timeoutMs = init.timeoutMs ?? 30000
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

      const snapUrl = `/api/snapshot${universeStrategy === 'gainers' ? '?universe=gainers&topN=50' : '?topN=50'}`
      const snap = await fetchJsonWithTimeout<MarketRawSnapshot>(snapUrl, { timeoutMs: 30000 })
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
        const allowPreview = dec.flag === 'NO-TRADE' ? Boolean(sCfg.preview_when_no_trade && forceCandidates) : false
        const candLimit = allowPreview ? (sCfg.preview_limit ?? 5) : (sCfg.max_setups ?? 3)
        const execMode = (() => { try { return localStorage.getItem('execution_mode') === '1' } catch { return false } })()
        // New rule: allow sim preview only for NO-TRADE + success_no_picks + execution_mode=false
        const canComputeSimPreview = (dec.flag === 'NO-TRADE' && finalPickerStatus === 'success_no_picks' && !execMode)
        const candList = selectCandidates(feats, data, {
          decisionFlag: dec.flag as any,
          allowWhenNoTrade: allowPreview,
          limit: Math.max(1, Math.min(candLimit, 12)),
          cfg: { atr_pct_min: sCfg.atr_pct_min, atr_pct_max: sCfg.atr_pct_max, min_liquidity_usdt: sCfg.min_liquidity_usdt },
          canComputeSimPreview,
          finalPickerStatus
        } as any)
        setCandidates(candList)
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
          const fpResp = await fetchJsonWithTimeout('/api/final_picker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 30000 })
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
              const okOrder = side === 'LONG'
                ? (p.sl < p.entry && p.entry < p.tp1 && p.tp1 <= p.tp2)
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

  // Safe clipboard write: requires focused document in modern browsers
  const writeClipboardSafely = async (text: string, { requireFocusForAuto = true }: { requireFocusForAuto?: boolean } = {}) => {
    try {
      const hasFocus = (() => { try { return typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { return true } })()
      const isVisible = (() => { try { return typeof document !== 'undefined' ? (document.visibilityState === 'visible') : true } catch { return true } })()
      if ((!hasFocus || !isVisible) && requireFocusForAuto) {
        try { window.focus() } catch {}
        await new Promise(res => setTimeout(res, 120))
        const focusedNow = (() => { try { return typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { return true } })()
        const visibleNow = (() => { try { return typeof document !== 'undefined' ? (document.visibilityState === 'visible') : true } catch { return true } })()
        if (!(focusedNow && visibleNow)) {
          const err = new Error('document_not_focused') as any
          err.code = 'document_not_focused'
          throw err
        }
      }
      await navigator.clipboard.writeText(text)
    } catch (e: any) {
      if (String(e?.code || e?.message || '').includes('document_not_focused')) throw e
      throw new Error(e?.message || 'write failed')
    }
  }

  const copyCoin = async (symbol: string) => {
    const sym = String(symbol || '')
    console.log('[COPY_COIN] Clicked symbol:', sym)
    if (!sym) return
    // Clear previous copied state to avoid confusion
    setCopiedSymbol(null)
    setLoadingSymbol(sym)
    try {
      const q = universeStrategy === 'gainers' ? '?universe=gainers' : ''
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
    setRawLoading(true)
    // Clear previous UI error state before fresh fetch
    setError(null)
    try {
      const q = `${universeStrategy === 'gainers' ? 'universe=gainers&' : ''}topN=50`
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
      const input = {
        coins,
        strategy: universeStrategy
      }

      const res = await fetch('/api/hot_screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })

      if (!res.ok) {
        let code = `HTTP ${res.status}`
        try { const j = await res.json(); if (j && typeof j === 'object') code = j.code || j?.meta?.http_error || code } catch {}
        throw new Error(String(code))
      }

      const result = await res.json()
      
      if (!result.ok) {
        throw new Error(result.code || 'Unknown error')
      }

      const hotPicks = result.data.hot_picks || []
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
          if (sym && !(reduceOnly || closePosition)) blocked.add(sym)
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
        const filtered = superHotSymbols.filter(s => !blocked.has(normalize(s)))
        setSelectedHotSymbols(filtered)
        setBlockedSymbols(Array.from(blocked))
      } catch {
        // Keep original selection to avoid flow changes when block-check fails
        setSelectedHotSymbols(superHotSymbols)
        setBlockedSymbols([])
      }
      
      setHotScreenerStatus('success')
    } catch (e: any) {
      setError(`Hot screener error: ${e?.message || 'unknown'}`)
      setHotScreenerStatus('error')
    }
  }

  const runEntryAnalysis = async () => {
    if (selectedHotSymbols.length === 0) return

    setEntryControlsStatus('loading')
    setEntryStrategies([])
    setCoinControls([])

    try {
      const strategies: EntryStrategyData[] = []
      const payloadsToCopy: Array<{ symbol: string; asset_data: any }> = []
      const priceMap: Record<string, number> = {}
      const failed: string[] = []
      
      for (const symbol of selectedHotSymbols) {
        // Get detailed asset data
        const assetRes = await fetchWithRetry(`/api/intraday_any?symbol=${encodeURIComponent(symbol)}`)
        if (!assetRes.ok) { failed.push(symbol); continue }

        const assetData = await assetRes.json()
        const assets = Array.isArray(assetData?.assets) ? assetData.assets : []
        const asset = assets.find((a: any) => a?.symbol === symbol)
        
        if (!asset) { failed.push(symbol); continue }
        // Collect exact GPT payload per symbol for auto-copy
        payloadsToCopy.push({ symbol, asset_data: asset })
        try { const p = Number(asset?.price); if (Number.isFinite(p) && p > 0) priceMap[symbol] = p } catch {}

        // Remember input payload (for copy-selected)
        setEntryInputsBySymbol(prev => ({ ...prev, [symbol]: { symbol, asset_data: asset } }))

        // Run entry strategy analysis
        const strategyRes = await fetch('/api/entry_strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol,
            asset_data: asset
          })
        })

        if (!strategyRes.ok) { failed.push(symbol); continue }

        const strategyResult = await strategyRes.json()
        
        if (strategyResult.ok && strategyResult.data) {
          strategies.push(strategyResult.data)
        } else { failed.push(symbol) }
      }

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
      setCurrentPrices(priceMap)

      // Initialize coin controls without any locked values – purely display and switches
      const controls: CoinControl[] = strategies.map(strategy => {
        const plan = defaultPreset === 'conservative' ? strategy.conservative : strategy.aggressive
        
        return {
          symbol: strategy.symbol,
          include: true,
          side: defaultSide,
          strategy: defaultPreset,
          tpLevel: defaultTPLevel,
          orderType: defaultPreset === 'conservative' ? 'limit' : 'stop_limit',
          amount: defaultAmount,
          leverage: defaultLeverage,
          useCustomBuffer: false,
        }
      })

      setCoinControls(controls)
      setEntryControlsStatus('success')
      // Ulož seznam failnutých pro zobrazení v EntryControls
      ;(window as any).__entry_failed_symbols = failed
    } catch (e: any) {
      setError(`Entry analysis error: ${e?.message || 'unknown'}`)
      setEntryControlsStatus('error')
    }
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

  const prepareOrders = async () => {
    try {
      setPlacingOrders(true)
      setError(null)
      const includedControls = coinControls.filter(c => c.include)
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
      // Map selected plan to numeric entry/SL/TP
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
      for (const c of includedControls) {
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
      const mapped = includedControls.map(c => {
        const plan = findPlan(c.symbol, c.strategy)
        if (!plan) throw new Error(`Missing strategy plan for ${c.symbol}`)
        const entry = Number((plan as any)?.entry)
        const sl = Number((plan as any)?.sl)
        const tpKey = c.tpLevel as 'tp1' | 'tp2' | 'tp3'
        const tpVal = Number((plan as any)?.[tpKey])
        console.log('[UI_ORDER_MAP]', { symbol: c.symbol, strategy: c.strategy, tpLevel: c.tpLevel, plan: { entry, sl, tp: tpVal } })
        console.log('[UI_PAYLOAD_VS_DISPLAY]', JSON.stringify({ symbol: c.symbol, payload: { entry, sl, tp: tpVal }, note: 'Check if this matches UI display' }, null, 2))

        return {
          symbol: c.symbol,
          side: (c.side || 'LONG') as any,
          strategy: c.strategy,
          tpLevel: c.tpLevel,
          orderType: c.orderType || (c.strategy === 'conservative' ? 'limit' : 'stop_limit'),
          amount: c.amount,
          leverage: c.leverage,
          entry,
          sl,
          tp: tpVal
        }
      })

      // Hard stop if any parsed numeric is missing/invalid (no fallbacks)
      {
        const badNum: string[] = []
        for (const o of mapped) {
          const issues: string[] = []
          if (!(typeof o.entry === 'number' && Number.isFinite(o.entry) && o.entry > 0)) issues.push('ENTRY')
          if (!(typeof o.sl === 'number' && Number.isFinite(o.sl) && o.sl > 0)) issues.push('SL')
          if (!(typeof o.tp === 'number' && Number.isFinite(o.tp) && o.tp > 0)) issues.push('TP')
          if (issues.length) badNum.push(`${o.symbol}: missing ${issues.join(', ')}`)
        }
        if (badNum.length) {
          setError(`Missing numeric values – orders not sent.\n${badNum.join('\n')}`)
          setPlacingOrders(false)
          return
        }
      }
      // STRICT 1:1 preflight – ověř, že klient posílá přesně čísla z aktuálního plánu (zobrazeného v UI)
      // Nezastavuj odeslání při drobných odchylkách; pouze varuj a pokračuj s UI hodnotami 1:1
      {
        const diffs: string[] = []
        for (const c of includedControls) {
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
      // MARK guards (client-side): pokračuj s validními, chybné vypiš
      const invalid: string[] = []
      const invalidSymbols = new Set<string>()
      for (const o of orders) {
        const mark = await getMark(o.symbol)
        if (!Number.isFinite(mark as any)) continue
        const sideLong = (o.side || 'LONG') === 'LONG'
        if (sideLong) {
          if (o.tp && !(o.tp > (mark as number))) { invalid.push(`${o.symbol}: TP ${o.tp} ≤ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
          if (o.sl && !(o.sl < (mark as number))) { invalid.push(`${o.symbol}: SL ${o.sl} ≥ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
        } else {
          if (o.tp && !(o.tp < (mark as number))) { invalid.push(`${o.symbol}: TP ${o.tp} ≥ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
          if (o.sl && !(o.sl > (mark as number))) { invalid.push(`${o.symbol}: SL ${o.sl} ≤ MARK ${(mark as number).toFixed(6)}`); invalidSymbols.add(o.symbol) }
        }
      }
      if (invalid.length) {
        // Only warn; do NOT filter out orders. Server enforces MARK guards strictly.
        setError(`Upozornění (MARK guard klient):\n${invalid.join('\n')}\nObjednávky odeslány – server zvaliduje přesně.`)
      }
      if (orders.length === 0) return
      const payload = { orders }
      console.log('[PLACE_ORDERS_PAYLOAD]', payload)

      const res = await fetch('/api/place_orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const json = await res.json().catch(()=>null)
      if (!res.ok || !json?.success) {
        const firstErr = Array.isArray(json?.orders) ? json.orders.find((o:any)=>o?.status==='error') : null
        const msg = json?.error || firstErr?.error || firstErr?.status || `HTTP ${res.status}`
        console.error('[PLACE_ORDERS_FAIL]', { status: res.status, response: json })
        setError(`Order submit failed: ${msg}`)
        return
      }
      console.log('[PLACE_ORDERS_OK]', json)

      // Post-verify 1:1 echo: compare payload vs server-accepted prices
      try {
        const toNum = (v:any)=>{ const n = Number(v); return Number.isFinite(n) ? n : 0 }
        const toNumOrNaN = (v:any)=>{ const n = Number(v); return Number.isFinite(n) ? n : NaN }
        const serverMap: Record<string, { entry: number; sl: number; tp: number }> = {}
        for (const r of (json.orders||[])) {
          const sym = String(r?.symbol||'')
          const entry = toNum(r?.entry_order?.price)
          const sl = toNum((r?.sl_order?.stopPrice ?? r?.sl_order?.price))
          // TP může být záměrně odložen (MARK gating) => pokud server TP neposlal, neporovnávejme s nulou
          const tpRaw = (r?.tp_order?.stopPrice ?? r?.tp_order?.price)
          const tp = toNumOrNaN(tpRaw)
          if (sym) serverMap[sym] = { entry, sl, tp }
        }
        const diffs: string[] = []
        for (const o of orders) {
          const s = serverMap[o.symbol]
          if (!s) continue
          const neq = (a:number,b:number)=> Math.abs(a-b) > 1e-9
          if (neq(toNum(o.entry), s.entry)) diffs.push(`${o.symbol} ENTRY: ${o.entry} vs ${s.entry}`)
          if (neq(toNum(o.sl), s.sl)) diffs.push(`${o.symbol} SL: ${o.sl} vs ${s.sl}`)
          // TP porovnej jen pokud server skutečně TP echo vrátil jako číslo (není NaN)
          if (Number.isFinite(s.tp) && neq(toNum(o.tp), s.tp)) diffs.push(`${o.symbol} TP: ${o.tp} vs ${s.tp}`)
        }
        if (diffs.length) {
          setError(`STRICT 1:1 echo mismatch (server):\n${diffs.join('\n')}`)
        }
      } catch {}
      // success notice: non-blocking (console only)
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
        universeStrategy={universeStrategy}
        onChangeUniverse={(u)=>setUniverseStrategy(u)}
        onCopyRawAll={copyRawAll}
        rawLoading={rawLoading}
        rawCopied={rawCopied}
        count={(displayCoins as any[]).length}
      />
      
      {/* BTC/ETH data integrated into DecisionBanner */}
      
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
      {Array.isArray(displayCoins) && (displayCoins as any[]).length > 0 && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong>Alt universe</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, opacity: .8 }}>Universe:</span>
              <button
                className={`btn toggle${universeStrategy === 'volume' ? ' active' : ''}`}
                onClick={() => setUniverseStrategy('volume')}
                aria-pressed={universeStrategy === 'volume'}
              >Volume</button>
              <button
                className={`btn toggle${universeStrategy === 'gainers' ? ' active' : ''}`}
                onClick={() => setUniverseStrategy('gainers')}
                aria-pressed={universeStrategy === 'gainers'}
              >Gainers 24h</button>
            </div>
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
                <button className="btn" onClick={() => { try { const raw = localStorage.getItem('m4FinalPicker'); if (raw) navigator.clipboard.writeText(raw) } catch {} }}>Copy details</button>
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
        onAnalyzeSelected={runEntryAnalysis}
        blockedSymbols={blockedSymbols}
      />

      {entryStrategies.length > 0 && (
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
        />
      )}
      {entryStrategies.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => { try { console.log('[ENTRY_STRATEGIES_SHOW]', JSON.stringify(entryStrategies, null, 2)) } catch {} }}>
            Show entryStrategies
          </button>
        </div>
      )}

      {/* Preview only table when picks are not ready or execution mode is off */}
      {candidates.length > 0 && (finalPickerStatus !== 'success' || !(localStorage.getItem('execution_mode') === '1')) ? (
        <CandidatesPreview list={candidates as any} finalPickerStatus={finalPickerStatus} executionMode={localStorage.getItem('execution_mode') === '1'} />
      ) : null}

      {/* Final picks table (no rules-based Setups) */}
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
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} lastSnapshot={snapshot} lastRunAt={lastRunAt} finalPickerStatus={finalPickerStatus} finalPicksCount={finalPicks.length} posture={(decision?.flag as any) ?? 'NO-TRADE'} />
    </div>
  );
};

