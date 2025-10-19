import React from 'react'
import { writeClipboard } from '../utils/clipboard'
import type { ExchangeFilters } from '../../../types/market_raw'

type FinalPick = {
  symbol: string
  label: 'SUPER_HOT' | 'HOT' | 'WATCH' | 'IGNORE'
  setup_type: 'MOMENTUM' | 'RECLAIM' | 'CONTINUATION'
  side: 'LONG' | 'SHORT'
  entry_type: 'MARKET' | 'LIMIT'
  entry: number
  sl: number
  tp1: number
  tp2: number
  trail: { mode: 'after_tp1_be_plus'; offset_r: number }
  expiry_minutes: number
  risk_pct: number
  leverage_hint?: number
  confidence: number
  reasons: string[]
  warnings?: string[]
}

type Settings = {
  execution_mode: boolean
  side_policy: 'long_only' | 'short_only' | 'both'
  max_picks: number
  preset: 'Momentum' | 'Conservative'
  confidence_go_now_threshold: number
  override_no_trade_execution: boolean
  override_no_trade_risk_pct: number
  no_trade_confidence_floor: number
  max_leverage?: number
  equity_usdt: number
}

type Props = {
  finalPicks: FinalPick[]
  finalPickerStatus: 'idle' | 'loading' | 'success' | 'success_no_picks' | 'error'
  finalPickerMeta: { latencyMs?: number | null; error_code?: string | null; error_message?: string | null; posture: 'OK' | 'CAUTION' | 'NO-TRADE'; candidatesCount: number; picksCount: number }
  posture: 'OK' | 'CAUTION' | 'NO-TRADE'
  settings: Settings
  exchangeFilters: ExchangeFilters | Record<string, { tickSize: number; stepSize: number; minQty: number; minNotional: number }>
  runStartedAt: number
}

function useNowTick(): number {
  const [now, setNow] = React.useState<number>(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function roundToTick(value: number, tickSize: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(tickSize) || tickSize <= 0) return value
  return Math.round(value / tickSize) * tickSize
}

function roundDown(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return NaN
  return Math.floor(value / step) * step
}

function fmtExpiryCountdown(now: number, startMs: number, minutes: number): { text: string; expired: boolean } {
  const end = startMs + minutes * 60_000
  const remainMs = Math.max(0, end - now)
  const expired = remainMs <= 0
  const mm = Math.floor(remainMs / 60000)
  const ss = Math.floor((remainMs % 60000) / 1000)
  return { text: `${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`, expired }
}

function tooltipForFactory(startMs: number) {
  return (p: FinalPick) => {
    const reasons = Array.isArray(p.reasons) ? p.reasons.slice(0, 3) : []
    const warns: string[] = []
    if (Array.isArray(p.warnings) && p.warnings.length) warns.push(p.warnings[0])
    if (p.expiry_minutes < 45) warns.push('Low time-to-expiry')
    const r = Math.abs((p.tp1 - p.entry) / (p.entry - p.sl))
    const trail = p.trail?.mode === 'after_tp1_be_plus' ? `TP1 moves SL to BE+ (trail ${Number(p.trail?.offset_r ?? 0).toFixed(2)}R)` : ''
    const parts = [
      ...reasons,
      ...(warns.length ? ['—', warns[0]] : []),
      ...(Number.isFinite(r) ? [`RRR ${r.toFixed(2)}`] : []),
      ...(trail ? [trail] : []),
    ]
    return parts.join('\n')
  }
}

function computeOrderPlanFactory(posture: 'OK'|'CAUTION'|'NO-TRADE', settings: Settings, exchangeFilters: any) {
  return (p: FinalPick) => {
    const f0 = (exchangeFilters as any)?.[p.symbol] || { tickSize: 1e-6, stepSize: 1e-6, minQty: 0, minNotional: 5 }
    const f = {
      tickSize: Number.isFinite(f0.tickSize) ? f0.tickSize : 1e-6,
      stepSize: Number.isFinite(f0.stepSize) ? f0.stepSize : 1e-6,
      minQty: Number.isFinite(f0.minQty) ? f0.minQty : 0,
      minNotional: Number.isFinite((f0 as any).minNotional ?? (f0 as any).notional) ? ((f0 as any).minNotional ?? (f0 as any).notional) : 5,
    }
    const filtersOk = Number.isFinite(f.tickSize) && Number.isFinite(f.stepSize) && Number.isFinite(f.minQty) && Number.isFinite(f.minNotional)
    const R = Math.abs(p.entry - p.sl)
    const baseRiskPct = (posture === 'NO-TRADE' && settings.override_no_trade_execution) ? settings.override_no_trade_risk_pct : (p.risk_pct ?? 0)
    const riskFraction = (baseRiskPct > 1 ? (baseRiskPct / 100) : baseRiskPct) || 0
    const riskPctDisplay = riskFraction * 100
    const riskUsd = settings.equity_usdt * riskFraction
    const rawQty = R > 0 ? (riskUsd / R) : 0
    const qty = filtersOk ? roundDown(rawQty, f.stepSize) : 0
    const notional = qty * roundToTick(p.entry, f.tickSize)
    const minQtyOk = filtersOk ? qty >= f.minQty : false
    const minNotionalOk = filtersOk ? notional >= f.minNotional : false
    const rTooTight = filtersOk ? (R < 5 * f.tickSize) : true
    const valid = filtersOk && qty > 0 && minQtyOk && minNotionalOk && !rTooTight
    const estLoss = qty * R
    const plTp1 = qty * Math.abs(roundToTick(p.tp1, f.tickSize) - roundToTick(p.entry, f.tickSize))
    const plTp2 = qty * Math.abs(roundToTick(p.tp2, f.tickSize) - roundToTick(p.entry, f.tickSize))
    const errors: string[] = []
    if (rTooTight) errors.push('R too tight')
    if (!minQtyOk) errors.push('Below minQty')
    if (!minNotionalOk) errors.push('Below minNotional')
    return { filters: f, R, riskFraction, riskPctDisplay, riskUsd, rawQty, qty, notional, minQtyOk, minNotionalOk, rTooTight, valid, estLoss, plTp1, plTp2 }
  }
}

export const SetupsTable: React.FC<Props> = ({ finalPicks, finalPickerStatus, finalPickerMeta, posture, settings, exchangeFilters, runStartedAt }) => {
  const now = useNowTick()
  const computeOrderPlan = React.useMemo(() => computeOrderPlanFactory(posture, settings, exchangeFilters), [posture, settings, exchangeFilters])
  const tooltipFor = React.useMemo(() => tooltipForFactory(runStartedAt), [runStartedAt])
  const canExecutionBeEnabledBase = finalPickerStatus === 'success' && (finalPicks?.length ?? 0) > 0
  const canExecutionBeEnabled = canExecutionBeEnabledBase && (posture === 'OK' || posture === 'CAUTION' || (posture === 'NO-TRADE' && settings.override_no_trade_execution))
  const executionMode = settings.execution_mode && canExecutionBeEnabled

  const filtered = React.useMemo(() => {
    const list = Array.isArray(finalPicks) ? finalPicks : []
    // SHORT-only project: remove long_only policy, enforce SHORT
    if (settings.side_policy === 'short_only') return list.filter(s => s.side === 'SHORT')
    // Default: only show SHORT picks (no long_only option)
    return list.filter(s => s.side === 'SHORT')
  }, [finalPicks, settings.side_policy])

  const limited = React.useMemo(() => filtered.slice(0, Math.max(1, Math.min(settings.max_picks || 6, 6))), [filtered, settings.max_picks])

  const canGoNow = React.useMemo(() => {
    if (posture === 'NO-TRADE') return false
    if (finalPickerStatus !== 'success') return false
    if (!(posture === 'OK' || posture === 'CAUTION')) return false
    return limited.some(p => (p.label === 'SUPER_HOT' || p.label === 'HOT') && p.expiry_minutes >= 60 && (p.confidence ?? 0) >= (settings.confidence_go_now_threshold ?? 0.6))
  }, [limited, finalPickerStatus, posture, settings.confidence_go_now_threshold])

  const noPicks = limited.length === 0

  const [confirming, setConfirming] = React.useState<FinalPick | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [executing, setExecuting] = React.useState(false)

  const copyToast = () => { setCopied(true); window.setTimeout(()=>setCopied(false), 1200) }

  const copyPicks = () => { try { writeClipboard(JSON.stringify(finalPicks ?? [], null, 2)) } catch { console.info('Clipboard skipped: document not focused') } }

  

  function serializePick(p: FinalPick) {
    const plan = computeOrderPlan(p)
    const entryR = p.entry
    const slR = p.sl
    const tp1R = p.tp1
    const tp2R = p.tp2
    const rrr1 = Math.abs((tp1R - entryR) / Math.max(1e-12, Math.abs(entryR - slR)))
    const rrr2 = Math.abs((tp2R - entryR) / Math.max(1e-12, Math.abs(entryR - slR)))
    const expiryAt = new Date(runStartedAt + (p.expiry_minutes * 60_000)).toISOString()
    const advisory = posture === 'NO-TRADE'
    const riskUsed = plan.riskFraction // 0-1
    return {
      symbol: p.symbol,
      posture,
      advisory,
      label: p.label,
      setup_type: p.setup_type,
      side: p.side,
      entry_type: (p as any).entry_type ?? 'LIMIT',
      entry: entryR,
      sl: slR,
      tp1: tp1R,
      tp2: tp2R,
      rrr_tp1: Number.isFinite(rrr1) ? Number(rrr1.toFixed(4)) : null,
      rrr_tp2: Number.isFinite(rrr2) ? Number(rrr2.toFixed(4)) : null,
      leverage_hint: p.leverage_hint ?? null,
      risk_pct_used: riskUsed,
      qty: Number.isFinite(plan.qty) ? Number(plan.qty.toFixed(6)) : 0,
      notional: Number.isFinite(plan.notional) ? Number(plan.notional.toFixed(2)) : 0,
      expiry_minutes: p.expiry_minutes,
      expiry_at: expiryAt,
      exchange_filters: plan.filters,
    }
  }

  async function copyRow(p: FinalPick) {
    try {
      const obj = serializePick(p)
      await writeClipboard(JSON.stringify(obj, null, 2))
      copyToast()
    } catch { console.info('Clipboard skipped: document not focused') }
  }

  async function copyAll() {
    try {
      const arr = limited.map(serializePick)
      await writeClipboard(JSON.stringify(arr, null, 2))
      copyToast()
    } catch { console.info('Clipboard skipped: document not focused') }
  }

  // Expose global trigger for ReportView without prop drilling
  React.useEffect(() => {
    const onCopyAll = () => { copyAll() }
    window.addEventListener('app-copy-all-picks', onCopyAll)
    return () => window.removeEventListener('app-copy-all-picks', onCopyAll)
  }, [limited])

  // Global keyboard shortcut: 'c' to copy all picks (lean)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTyping = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable === true || target.tagName === 'SELECT')
      if (isTyping) return
      if (e.key === 'c' || e.key === 'C') {
        if (finalPickerStatus === 'success' && (finalPicks?.length ?? 0) > 0) {
          window.dispatchEvent(new Event('app-copy-all-picks'))
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finalPickerStatus, finalPicks])

  return (
    <details style={{ marginTop: 16 }} open>
      <summary style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Setups
        {canGoNow && (
          <span style={{ fontSize: 12, background: '#065f46', color: '#e6ffed', padding: '2px 6px', borderRadius: 12 }}>Go NOW</span>
        )}
      </summary>

      {/* Error / empty states */}
      {finalPickerStatus === 'error' && (
        <div className="error" style={{ margin: '8px 0' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <strong>Final Picker selhal (STRICT NO-FALLBACK)</strong>
            <button className="btn" onClick={()=>{ try { writeClipboard(JSON.stringify(finalPickerMeta ?? {}, null, 2)) } catch { console.info('Clipboard skipped: document not focused') } }}>Copy details</button>
          </div>
          <div style={{ fontSize: 12, opacity: .9, marginTop: 4 }}>Code: {finalPickerMeta?.error_code ?? 'unknown'}</div>
        </div>
      )}
      {finalPickerStatus === 'success_no_picks' && (
        <div className="card" style={{ margin: '8px 0' }}>Žádné kvalitní setupy (0)</div>
      )}

      <div className="row gap-8" style={{ margin: '8px 0', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="row gap-8">
          <button className="btn" onClick={copyAll}>Copy all picks (JSON)</button>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: canExecutionBeEnabled ? 1 : 0.6 }} title={canExecutionBeEnabled ? '' : (posture === 'NO-TRADE' ? 'NO-TRADE' : (finalPickerStatus !== 'success' ? 'Final Picker není připraven' : 'No picks'))}>
            <input type="checkbox" checked={executionMode} disabled={!canExecutionBeEnabled} onChange={e => { try { localStorage.setItem('execution_mode', e.target.checked ? '1' : '0') } catch {}; window.dispatchEvent(new Event('app-settings-changed')) }} />
            Execution mode
          </label>
        </div>
      </div>

      {noPicks ? (
        <div style={{ color: '#9ca3af' }}>No picks</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Symbol</th>
              <th>Label</th>
              <th>Type</th>
              <th>Side</th>
              <th>Entry</th>
              <th>SL</th>
              <th>TP1</th>
              <th>TP2</th>
              <th>RRR</th>
              <th>Risk%</th>
              <th>Lev</th>
              <th>Conf</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {limited.map((p) => {
              const rrr = Math.abs((p.tp1 - p.entry) / (p.entry - p.sl))
              const { text, expired } = fmtExpiryCountdown(now, runStartedAt, p.expiry_minutes)
              const isAdvisory = posture === 'NO-TRADE'
              const canOverride = settings.override_no_trade_execution && (p.confidence ?? 0) >= (settings.no_trade_confidence_floor ?? 0.65)
              const entryR = p.entry
              const slR = p.sl
              const tp1R = p.tp1
              const tp2R = p.tp2
              const snapTs = (()=>{ try { const raw = localStorage.getItem('lastRunAtMs'); return raw ? Number(raw) : runStartedAt } catch { return runStartedAt } })()
              const staleMs = Date.now() - snapTs
              const isStale5 = Number.isFinite(staleMs as any) && staleMs >= 5*60_000
              return (
                <tr key={p.symbol} title={tooltipFor(p)} style={{ opacity: expired ? 0.6 : 1 }}>
                  <td>
                    {p.symbol}
                    {isAdvisory ? (<span className="pill" style={{ marginLeft: 6 }}>Advisory (NO-TRADE)</span>) : null}
                  </td>
                  <td>{p.label}</td>
                  <td>{p.setup_type}</td>
                  <td>{p.side}</td>
                  <td>{entryR}</td>
                  <td>{slR}</td>
                  <td>{tp1R}</td>
                  <td>{tp2R}</td>
                  <td>{Number.isFinite(rrr) ? rrr.toFixed(2) : '—'}</td>
                  <td>{((p.risk_pct > 1 ? (p.risk_pct / 100) : p.risk_pct) * 100).toFixed(2)}%</td>
                  <td>{p.leverage_hint ?? '—'}</td>
                  <td>{(p.confidence ?? 0).toFixed(2)}</td>
                  <td>{text}</td>
                  <td style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                    <button className="btn" onClick={()=>copyRow(p)} title="Copy trade">📋</button>
                    {executionMode ? (
                      <button className="btn" disabled={expired || (isAdvisory && !canOverride) || isStale5} title={isStale5 ? 'Disabled: stale snapshot ≥5 min' : ((isAdvisory && !canOverride) ? 'NO-TRADE override required and confidence not met' : '')} onClick={() => setConfirming(p)}>Execute…</button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {confirming && (() => {
        const plan = computeOrderPlan(confirming)
        const disabled = !plan.valid
        const reason = !plan.filters ? 'Missing exchange filters' : (!plan.minQtyOk ? 'Below minQty' : (!plan.minNotionalOk ? 'Below minNotional' : (plan.rTooTight ? 'R too tight' : '')))
        const needsAccept = posture === 'NO-TRADE' && settings.override_no_trade_execution === true
        const [accept, setAccept] = React.useState(false as any)
        const showSoftWarn = needsAccept && (settings.override_no_trade_risk_pct > 0.5)
        return (
          <div role="dialog" aria-modal="true" className="modal" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="card" style={{ minWidth: 380, maxWidth: 560, background: '#fff', padding: 16, borderRadius: 8 }}>
              <div className="space-between" style={{ marginBottom: 8, alignItems:'center' }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <strong>Confirm order</strong>
                  {showSoftWarn ? (<span className="pill" style={{ background:'#fff3cd', color:'#92400e' }}>High override risk</span>) : null}
                </div>
                <button className="btn" onClick={() => setConfirming(null)}>Close</button>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.7 }}>
                <div><b>Symbol</b>: {confirming.symbol}</div>
                <div><b>Side</b>: {confirming.side}</div>
                <div><b>Entry</b>: {confirming.entry}</div>
                <div><b>Stop Loss</b>: {confirming.sl}</div>
                <div><b>TP1</b>: {confirming.tp1} &nbsp; <b>TP2</b>: {confirming.tp2}</div>
                <div><b>Risk % of equity</b>: {plan.riskPctDisplay.toFixed(2)}%</div>
                <div><b>Equity</b>: ${settings.equity_usdt.toLocaleString()}</div>
                <div><b>R</b>: {plan.R.toFixed(6)}</div>
                <div><b>Qty</b>: {Number.isFinite(plan.qty) ? plan.qty.toFixed(6) : '—'}</div>
                <div><b>Notional</b>: {Number.isFinite(plan.notional) ? plan.notional.toFixed(2) : '—'}</div>
                <div><b>Est. loss at SL</b>: {plan.estLoss.toFixed(2)}</div>
                <div><b>Est. P/L at TP1</b>: {plan.plTp1.toFixed(2)} &nbsp; <b>TP2</b>: {plan.plTp2.toFixed(2)}</div>
                <div><b>Leverage hint</b>: {confirming.leverage_hint ?? '—'}{(settings.max_leverage && confirming.leverage_hint && confirming.leverage_hint > settings.max_leverage) ? <span className="pill" style={{ marginLeft: 6, background:'#fff3cd', color:'#92400e' }}>High leverage</span> : null}</div>
                {needsAccept ? (
                  <label style={{ display:'flex', alignItems:'center', gap:8, marginTop: 8, fontSize: 12 }}>
                    <input type="checkbox" checked={accept} onChange={e=>setAccept(e.target.checked)} /> I accept NO-TRADE risk
                  </label>
                ) : null}
                {reason ? <div style={{ color: 'crimson', marginTop: 4 }}>{reason}</div> : null}
              </div>
              <div className="row gap-8" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                <button className="btn" disabled={disabled || (needsAccept && !accept) || executing} title={disabled ? reason : (needsAccept && !accept ? 'Please accept NO-TRADE risk' : '')} onClick={() => { if (executing) return; setExecuting(true); try { writeClipboard(JSON.stringify({ pick: confirming, plan }, null, 2)) } catch { console.info('Clipboard skipped: document not focused') }; setTimeout(()=>setExecuting(false), 2000); setConfirming(null) }}>
                  {executing ? 'Executing…' : 'Execute'}{showSoftWarn ? <span className="pill" style={{ marginLeft: 6, background:'#fff3cd', color:'#92400e' }}>warn</span> : null}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {copied ? (
        <div style={{ position:'fixed', bottom: 16, right: 16, background:'#111', color:'#fff', padding:'6px 10px', borderRadius:6, fontSize:12 }}>Copied</div>
      ) : null}
    </details>
  )
}


