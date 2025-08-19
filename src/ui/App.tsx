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

export const App: React.FC = () => {
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
  const [copiedSymbol, setCopiedSymbol] = useState<string | null>(null);
  const [rawCopied, setRawCopied] = useState(false);
  const [rawRegime, setRawRegime] = useState<{ btc_h1?: number | null } | null>(null)
  const [rawLoading, setRawLoading] = useState(false);
  const [loadingSymbol, setLoadingSymbol] = useState<string | null>(null);
  const [rawCoins, setRawCoins] = useState<any[] | null>(null);
  const [universeStrategy, setUniverseStrategy] = useState<'volume' | 'gainers'>(() => {
    try { return (localStorage.getItem('universe_strategy') as any) === 'gainers' ? 'gainers' : 'volume' } catch { return 'volume' }
  });
  useEffect(() => { try { localStorage.setItem('universe_strategy', universeStrategy) } catch {} }, [universeStrategy])
  const prevStrategyRef = useRef(universeStrategy)
  useEffect(() => {
    if (prevStrategyRef.current !== universeStrategy) {
      setRawCoins(null)
      try { localStorage.removeItem('rawCoins') } catch {}
    }
    prevStrategyRef.current = universeStrategy
  }, [universeStrategy])
  const [forceCandidates, setForceCandidates] = useState<boolean>(() => {
    try { return localStorage.getItem('forceCandidates') === '1' } catch { return true }
  });
  useEffect(() => { try { localStorage.setItem('forceCandidates', forceCandidates ? '1' : '0') } catch {} }, [forceCandidates]);

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

  const coinsSource = useMemo(() => {
    if (rawCoins && Array.isArray(rawCoins) && rawCoins.length > 0) return rawCoins
    return snapshot?.universe || []
  }, [rawCoins, snapshot])
  
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
    setRunning(true);
    setError(null);
    setErrorPayload(null);
    try {
      const nowMs = Date.now();
      setRunStartedAt(nowMs);
      try { localStorage.setItem('lastRunAtMs', String(nowMs)) } catch {}
      async function fetchJsonWithTimeout<T=any>(input: RequestInfo | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; json: T | null }> {
        const ac = new AbortController()
        const timeoutMs = init.timeoutMs ?? 12000
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

      const snapUrl = `/api/snapshot${universeStrategy === 'gainers' ? '?universe=gainers' : ''}`
      const snap = await fetchJsonWithTimeout<MarketRawSnapshot>(snapUrl, { timeoutMs: 25000 })
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
          const fpResp = await fetchJsonWithTimeout('/api/final_picker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 15000 })
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
      // persist
      try {
        localStorage.setItem('m1Snapshot', JSON.stringify(data));
        localStorage.setItem('m2Features', JSON.stringify(feats));
        localStorage.setItem('m3Decision', JSON.stringify(dec));
        localStorage.setItem('m4SignalSet', JSON.stringify(signalSet));
        try { localStorage.setItem('m4FinalPicker', localStorage.getItem('m4FinalPicker') || '') } catch {}
        localStorage.setItem('lastRunAt', String(new Date().toISOString()));
      } catch {}
    } catch (e: any) {
      setError(e?.message ?? 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  const onExport = () => { if (snapshot) downloadJson(snapshot, 'snapshot') };

  const onExportFeatures = () => { if (features) downloadJson(features, 'features') };

  const copyCoin = async (coinData: any) => {
    const sym = String(coinData?.symbol || '')
    if (!sym) return
    setLoadingSymbol(sym)
    try {
      const q = universeStrategy === 'gainers' ? '?universe=gainers' : ''
      const sep = q ? '&' : '?'
      const res = await fetch(`/api/intraday${q}${sep}symbol=${encodeURIComponent(sym)}`)
      if (res.ok) {
        const json: any = await res.json()
        const assets: any[] = Array.isArray(json?.assets) ? json.assets : []
        const asset = assets.find(a => a?.symbol === sym) || null
        if (asset) {
          try {
            await navigator.clipboard.writeText(JSON.stringify(asset, null, 2))
          } catch (e: any) {
            setError(`Clipboard error: ${e?.message || 'write failed'}`)
            return
          }
          setCopiedSymbol(sym)
          window.setTimeout(() => setCopiedSymbol(null), 1200)
        } else {
          setError(`Server returned no matching asset for ${sym}.`)
        }
      } else {
        let msg = `HTTP ${res.status} for /api/intraday?symbol=${sym}`
        try { const j = await res.json(); if (j?.error) msg = `${j.error} (${res.status}) for ${sym}` } catch {}
        setError(msg)
      }
    } catch {}
    finally { setLoadingSymbol(null) }
  }

  const copyRawAll = async () => {
    setRawLoading(true)
    try {
      const q = `${universeStrategy === 'gainers' ? 'universe=gainers&' : ''}topN=50`
      const res = await fetch(`/api/metrics?${q}`)
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
      
      const coins = Array.isArray(json?.coins) ? json.coins : []
      if (coins.length === 0) {
        setError('No coins data received from server')
        return
      }
      
      // Update UI state immediately (even if clipboard fails later)
      setRawCoins(coins)
      try { localStorage.setItem('rawCoins', JSON.stringify({ strategy: universeStrategy, coins, timestamp: Date.now() })) } catch {}
      
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
      
      // OPRAVA: Validace velikosti před kopírováním
      try {
        const jsonString = JSON.stringify(coins, null, 2)
        const sizeKB = new Blob([jsonString]).size / 1024
        
        if (sizeKB > 1024) { // Limit 1MB
          setError(`Data too large for clipboard (${sizeKB.toFixed(0)}KB). Max 1MB allowed.`)
          return
        }
        
        await navigator.clipboard.writeText(jsonString)
      } catch (e: any) {
        setError(`Clipboard error: ${e?.message || 'write failed'}`)
        return
      }
      
      setRawCopied(true)
      window.setTimeout(() => setRawCopied(false), 1400)
    } catch (e: any) {
      setError(`Network error: ${e?.message || 'request failed'}`)
    } finally { 
      setRawLoading(false) 
    }
  }

  // WS health poll (best-effort)
  useEffect(() => {
    let mounted = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const res = await fetch('/api/ws/health')
        if (res.ok) {
          const h = await res.json()
          if (mounted) setWsHealth(h)
        } else {
          if (mounted) setWsHealth(null)
        }
      } catch { if (mounted) setWsHealth(null) }
      timer = window.setTimeout(poll, 4000)
    }
    poll()
    return () => { mounted = false; if (timer) clearTimeout(timer) }
  }, [])

  // No auto-run on load; wait for explicit user click

  useEffect(() => {
    try {
      const sRaw = localStorage.getItem('m1Snapshot');
      const fRaw = localStorage.getItem('m2Features');
      const dRaw = localStorage.getItem('m3Decision');
      const setRaw = localStorage.getItem('m4SignalSet');
      const lastRun = localStorage.getItem('lastRunAt');
      // Restore RAW coins if present for current strategy
      try {
        const rc = localStorage.getItem('rawCoins')
        if (rc) {
          const parsed = JSON.parse(rc)
          const coins = Array.isArray(parsed?.coins) ? parsed.coins : (Array.isArray(parsed) ? parsed : null)
          const st = (parsed && typeof parsed === 'object' && parsed.strategy) ? parsed.strategy : null
          if (coins && (!st || st === universeStrategy)) setRawCoins(coins)
        }
      } catch {}
      if (sRaw) setSnapshot(JSON.parse(sRaw));
      if (fRaw) {
        const feats = JSON.parse(fRaw);
        setFeatures(feats);
        try {
          if (dRaw) setDecision(JSON.parse(dRaw)); else {
            const dec = decideFromFeatures(feats);
            setDecision(dec);
          }
          if (setRaw) setSignalSet(JSON.parse(setRaw));
        } catch {}
      }
      if (lastRun) setLastRunAt(lastRun);
    } catch {}
  }, []);

  // Keyboard shortcuts: r (run), s (export snapshot), f (export features)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable === true || target.tagName === 'SELECT'
      )
      if (isTyping) return
      if (e.key === 'r' || e.key === 'R') {
        if (!running) onRun()
      } else if (e.key === 's' || e.key === 'S') {
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
      <HeaderBar running={running} onRun={onRun} onExportSnapshot={onExport} onExportFeatures={onExportFeatures} onToggleSettings={() => setSettingsOpen(true)} onToggleReport={() => setShowReport(v => !v)} showingReport={showReport} />
      {showReport ? (
        <ReportView snapshot={snapshot} features={features} decision={decision} signals={signalSet} featuresMs={featuresMs ?? null} />
      ) : (
        <>
      {decision && (
        <>
          <DecisionBanner decision={decision} rawBtcH1={rawRegime?.btc_h1 ?? null} />
          <div style={{ height: 8 }} />
        </>
      )}
      <StatusPills
        feedsOk={snapshot?.feeds_ok ?? null}
        snapshotMs={(snapshot as any)?.duration_ms ?? (snapshot as any)?.latency_ms ?? null}
        featuresMs={featuresMs}
        symbols={snapshot?.universe?.length != null ? (2 + snapshot.universe.length) : null}
        ws={wsHealth}
      />
      <SnapshotBanner
        feedsOk={!!snapshot?.feeds_ok}
        latencyMs={(snapshot as any)?.duration_ms ?? (snapshot as any)?.latency_ms ?? 0}
        symbolsLoaded={symbolsLoaded}
        featuresMs={featuresMs}
        breadthPct={features?.breadth.pct_above_EMA50_H1 ?? null}
        ageMs={snapshotAgeMs ?? undefined}
        onRun={onRun}
      />
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
      {snapshot && Array.isArray(snapshot.universe) && (
        <div className="card" style={{ marginTop: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Alt universe</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, opacity: .8 }}>count: {(displayCoins as any[]).length}</span>
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
              <button className="btn" style={{ border: '2px solid #333' }} onClick={copyRawAll} aria-label="Copy RAW dataset (all alts)" title={rawCopied ? 'Zkopírováno' : 'Copy RAW dataset'} disabled={rawLoading}>
                {rawLoading ? 'Stahuji…' : (rawCopied ? 'RAW zkopírováno ✓' : 'Copy RAW (vše)')}
              </button>
            </div>
          </div>
          {/* Per-coin copy buttons below header for clarity */}
          <div className="coins-grid">
            {(displayCoins as any[]).map((u: any, idx: number) => (
              <div key={u.symbol} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, border: '1px solid #2a2a2a', padding: '4px 6px', borderRadius: 6 }}>
                <span style={{ fontSize: 11, opacity: .8 }}>#{idx + 1}</span>
                <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', fontSize: 13, opacity: .95, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '70%', pointerEvents: 'none' }}>
                  {formatSymbol(u.symbol)}
                </span>
                <button className="btn" onClick={() => copyCoin(u)} aria-label={`Copy ${u.symbol} JSON`} title={copiedSymbol === u.symbol ? 'Zkopírováno' : 'Copy to clipboard'} disabled={loadingSymbol === u.symbol} style={{ padding: '3px 6px', fontSize: 11 }}>
                  {loadingSymbol === u.symbol ? 'Stahuji…' : (copiedSymbol === u.symbol ? '✓' : 'Copy')}
                </button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <textarea
              readOnly
              style={{ width: '100%', height: 100, fontFamily: 'monospace', fontSize: 12 }}
              value={snapshot.universe.map(u => u.symbol).join(', ')}
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
        </>
      )}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} lastSnapshot={snapshot} lastRunAt={lastRunAt} finalPickerStatus={finalPickerStatus} finalPicksCount={finalPicks.length} posture={(decision?.flag as any) ?? 'NO-TRADE'} />
    </div>
  );
};

