import React, { useEffect, useState } from 'react'

export type TopUpExecutorEntry = {
  symbol: string
  pilotEntryPrice: number
  pilotSize: number
  multiplier: number
  plannedTotalSize: number
  topUpsEmitted: number
  watcherReasonCode: string | null
  watcherConfidence: number | null
  since: string
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing'
  triggerAt: string
  cycleIndex: number
  lastError?: string | null
  lastErrorAt?: string | null
}

type ControlProps = {
  hasPositions: boolean
  hasActiveTimers: boolean
  enabled: boolean
  onToggle: (val: boolean) => Promise<void> | void
}

type RowProps = {
  symbol: string
  entry?: TopUpExecutorEntry | null
  enabled?: boolean
}

type AuditLatest = {
  phase?: string
  top_up_ratio?: number | null
  top_up_size?: number | null
  confidence?: number | null
  rationale?: string | null
  ts?: string
  watcher_reason_code?: string | null
}

const fmtSeconds = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const RenderAudit: React.FC<{ latest: AuditLatest | null }> = ({ latest }) => {
  if (!latest) return null
  const phase = String(latest.phase || '').toLowerCase()
  const ratio = latest.top_up_ratio != null ? Number(latest.top_up_ratio).toFixed(2) : null
  const size = latest.top_up_size != null ? Number(latest.top_up_size).toFixed(3) : null
  const conf = latest.confidence != null ? Number(latest.confidence).toFixed(2) : null
  const ts = latest.ts ? new Date(latest.ts).toLocaleTimeString() : ''
  const reasonCode = latest.watcher_reason_code ? ` · ${latest.watcher_reason_code}` : ''
  if (phase === 'executed') {
    return (
      <span style={{ fontSize: 10, color: '#10b981' }} title={latest.rationale || ''}>
        🟢 ratio {ratio} · qty {size}{conf ? ` · conf ${conf}` : ''}{reasonCode}{ts ? ` · ${ts}` : ''}
      </span>
    )
  }
  if (phase === 'skipped' || phase === 'cooldown_skip' || phase === 'no_op_below_step') {
    return (
      <span style={{ fontSize: 10, color: '#9ca3af' }} title={latest.rationale || ''}>
        ⚪ {phase.replace('_', ' ')}{conf ? ` · conf ${conf}` : ''}{reasonCode}{ts ? ` · ${ts}` : ''}
      </span>
    )
  }
  if (phase === 'aborted') {
    return (
      <span style={{ fontSize: 10, color: '#f97316' }} title={latest.rationale || ''}>
        🟠 aborted{reasonCode}{ts ? ` · ${ts}` : ''}
      </span>
    )
  }
  if (phase === 'process_error' || phase === 'ai_failed') {
    return (
      <span style={{ fontSize: 10, color: '#dc2626' }} title={latest.rationale || ''}>
        ❗ {phase}{ts ? ` · ${ts}` : ''}
      </span>
    )
  }
  return null
}

const Control: React.FC<ControlProps> = ({ hasPositions, hasActiveTimers, enabled, onToggle }) => {
  const [syncing, setSyncing] = useState(false)
  const [multiplier, setMultiplier] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('topup_multiplier')
      if (stored) {
        const n = Number(stored)
        if (Number.isFinite(n) && n > 0) return n
      }
    } catch {}
    return 1
  })
  const [savingMultiplier, setSavingMultiplier] = useState(false)
  const status = (() => {
    if (!enabled) return { color: '#ef4444', text: '🔴 VYPNUTO', desc: 'Top-Up Executor je vypnutý' }
    if (hasActiveTimers) return { color: '#22c55e', text: '🟢 AKTIVNÍ', desc: 'AI připravuje dokupy' }
    if (hasPositions) return { color: '#f59e0b', text: '🟠 ČEKÁ', desc: 'Pozice aktivní, čekáme na signál' }
    return { color: '#f59e0b', text: '🟠 WAITING', desc: 'Žádná pozice k rozšíření' }
  })()

  const handleToggle = async (val: boolean) => {
    setSyncing(true)
    try { await onToggle(val) } finally { setSyncing(false) }
  }

  const onChangeMultiplier = async (value: number) => {
    const val = Number.isFinite(value) ? Number(value) : 1
    const sanitized = val > 0 ? val : 1
    setMultiplier(sanitized)
    try { localStorage.setItem('topup_multiplier', String(sanitized)) } catch {}
    setSavingMultiplier(true)
    try {
      await fetch('/api/top_up_multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ multiplier: sanitized })
      })
    } catch {}
    setSavingMultiplier(false)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <strong style={{ fontSize: 14, color: status.color }}>Top-Up Executor</strong>
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{status.desc}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: status.color, fontWeight: 600 }}>{status.text}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} disabled={syncing} onChange={e => handleToggle(e.target.checked)} style={{ cursor: 'pointer' }} />
            <span style={{ fontSize: 12, opacity: syncing ? 0.5 : 1 }}>{syncing ? 'Sync...' : (enabled ? 'ON' : 'OFF')}</span>
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, opacity: 0.8 }}>Top-Up násobek</label>
          <input
            type="number"
            step={0.1}
            value={multiplier}
            onChange={e => onChangeMultiplier(Number(e.target.value))}
            style={{ width: 80, fontSize: 12, padding: '2px 4px', background: '#111827', color: '#f9fafb', border: '1px solid #374151', borderRadius: 4 }}
          />
          <span style={{ fontSize: 10, opacity: 0.7 }}>{savingMultiplier ? 'Ukládám…' : ''}</span>
        </div>
      </div>
    </div>
  )
}

const Row: React.FC<RowProps> = ({ symbol, entry: entryProp, enabled }) => {
  const [entry, setEntry] = useState<TopUpExecutorEntry | null>(entryProp ?? null)
  const [countdown, setCountdown] = useState<number>(0)
  const [latest, setLatest] = useState<AuditLatest | null>(null)

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
        const r = await fetch(`/api/top_up_executor_audit/latest?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' })
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

  if (!enabled) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  if (!entry) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>

  if (entry.status === 'waiting') {
    if (countdown > 0) {
      return (
        <div style={{ fontSize: 10, textAlign: 'center' }}>
          <div style={{ color: '#f59e0b' }}>🟡 {fmtSeconds(countdown)}</div>
          <div style={{ color: '#6b7280', fontSize: 8 }}>top-up executor</div>
          <div style={{ marginTop: 2 }}><RenderAudit latest={latest} /></div>
        </div>
      )
    }
    return (
      <div style={{ fontSize: 10, textAlign: 'center' }}>
        <span style={{ color: '#f59e0b' }}>🟡 Due</span>
        <div style={{ marginTop: 2 }}><RenderAudit latest={latest} /></div>
      </div>
    )
  }

  if (entry.status === 'processing') {
    return (
      <div style={{ fontSize: 10, textAlign: 'center' }}>
        <div style={{ color: '#3b82f6' }}>🔵 Processing</div>
        <div style={{ color: '#6b7280', fontSize: 8 }}>market buy</div>
        <div style={{ marginTop: 2 }}><RenderAudit latest={latest} /></div>
      </div>
    )
  }

  if (entry.lastError) {
    return <span style={{ fontSize: 10, color: '#dc2626' }} title={entry.lastError}>❗ Error</span>
  }

  return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
}

const TopUpExecutorStatus = {
  Control,
  Row
}

export default TopUpExecutorStatus
