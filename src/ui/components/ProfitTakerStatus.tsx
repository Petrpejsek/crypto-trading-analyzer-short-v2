import React, { useEffect, useState } from 'react'

type ProfitTakerEntry = {
  symbol: string
  entryPrice: number
  positionSize: number
  since: string
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing'
  triggerAt: string
  cycleIndex: number
  lastError?: string | null
  lastErrorAt?: string | null
}

type Props = {
  symbol: string
  entry?: ProfitTakerEntry | null
  enabled?: boolean
}

type AuditLatest = {
  phase?: string
  take_percent?: number | null
  qty_sent?: number | null
  pct_left?: number | null
  confidence?: number | null
  rationale?: string | null
  ts?: string
}

export const ProfitTakerStatus: React.FC<Props> = ({ symbol, entry: entryProp, enabled }) => {
  const [entry, setEntry] = useState<ProfitTakerEntry | null>(entryProp ?? null)
  const [countdown, setCountdown] = useState<number>(0)
  const [isEnabled, setIsEnabled] = useState<boolean>(Boolean(enabled))
  const [latest, setLatest] = useState<AuditLatest | null>(null)

  useEffect(() => { setIsEnabled(Boolean(enabled)) }, [enabled])
  useEffect(() => { setEntry(entryProp ?? null) }, [entryProp, symbol])

  useEffect(() => {
    if (!entry || entry.status !== 'waiting') return
    const update = () => {
      try {
        const t = new Date(entry.triggerAt).getTime()
        const now = Date.now()
        const remain = Math.max(0, Math.floor((t - now) / 1000))
        setCountdown(remain)
      } catch { setCountdown(0) }
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [entry])

  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/profit_taker_audit/latest?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json().catch(()=>null)
          if (!stop) setLatest((j && j.entry) ? j.entry : null)
        }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { stop = true; clearInterval(id) }
  }, [symbol])

  const fmt = (s: number): string => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  if (!isEnabled) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  if (!entry) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>

  const renderTelemetry = () => {
    if (!latest) return null
    const phase = String(latest.phase || '').toLowerCase()
    const pct = (latest.take_percent != null) ? Math.round(Number(latest.take_percent) * 10) / 10 : null
    const left = (latest.pct_left != null) ? Math.round(Number(latest.pct_left) * 10) / 10 : null
    const conf = (latest.confidence != null) ? Math.round(Number(latest.confidence) * 100) / 100 : null
    const ts = latest.ts ? new Date(latest.ts).toLocaleTimeString() : ''
    if (phase === 'executed') {
      return (
        <span title={latest.rationale || ''} style={{ fontSize: 10, color: '#10b981' }}>
          🟢 Sold {pct}%{left!=null?` · left ${left}%`:''}{conf!=null?` · conf ${conf}`:''}{ts?` · ${ts}`:''}
        </span>
      )
    }
    if (phase === 'skipped' || phase === 'cooldown_skip' || phase === 'no_op_below_step') {
      return (
        <span title={latest.rationale || ''} style={{ fontSize: 10, color: '#9ca3af' }}>
          ⚪ {phase.replace('_',' ')}{conf!=null?` · conf ${conf}`:''}{ts?` · ${ts}`:''}
        </span>
      )
    }
    if (phase === 'ai_failed' || phase === 'process_error') {
      return (
        <span title={latest.rationale || ''} style={{ fontSize: 10, color: '#dc2626' }}>
          ❗ {phase}{ts?` · ${ts}`:''}
        </span>
      )
    }
    return null
  }

  if (entry.status === 'waiting') {
    if (countdown > 0) {
      return (
        <div style={{ fontSize: 10, textAlign: 'center' }}>
          <div style={{ color: '#f59e0b' }}>🟡 {fmt(countdown)}</div>
          <div style={{ color: '#6b7280', fontSize: 8 }}>profit taker</div>
          <div style={{ marginTop: 2 }}>{renderTelemetry()}</div>
        </div>
      )
    }
    return (
      <div style={{ fontSize: 10, textAlign: 'center' }}>
        <span style={{ color: '#f59e0b' }}>🟡 Due</span>
        <div style={{ marginTop: 2 }}>{renderTelemetry()}</div>
      </div>
    )
  }
  if (entry.status === 'processing') {
    return (
      <div style={{ fontSize: 10, textAlign: 'center' }}>
        <div style={{ color: '#3b82f6' }}>🔵 Processing</div>
        <div style={{ color: '#6b7280', fontSize: 8 }}>market reduceOnly</div>
        <div style={{ marginTop: 2 }}>{renderTelemetry()}</div>
      </div>
    )
  }
  if (entry.lastError) {
    return <span style={{ fontSize: 10, color: '#dc2626' }} title={entry.lastError}>❗ Error</span>
  }
  return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
}

export default ProfitTakerStatus


