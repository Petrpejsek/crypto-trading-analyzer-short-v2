import React, { useEffect, useRef, useState } from 'react'

type WatcherEntry = {
  symbol: string
  startedAt: string
  deadlineAt: string
  status: 'running' | 'completed'
  nextRunAt: string
  checks: number
  debounceCounter: number
  lastResult: 'HOLD' | 'TOP_UP_ELIGIBLE' | 'ABORT_TOPUP' | null
  lastTickAt: string | null
  lastError?: string | null
}

type Props = {
  symbol: string
  entry?: WatcherEntry | null
  enabled?: boolean
}

type WatcherEvent = {
  action: 'HOLD' | 'TOP_UP_ELIGIBLE' | 'ABORT_TOPUP'
  reason_code?: string
  reasoning?: string
  confidence?: number
  snapshot_ts?: string
  ts?: string
}

const WatcherStatus: React.FC<Props> = ({ symbol, entry, enabled }) => {
  const [latest, setLatest] = useState<WatcherEvent | null>(null)
  const [countdown, setCountdown] = useState<number>(0)
  const [processing, setProcessing] = useState<boolean>(false)
  const targetTsRef = useRef<number | null>(null)
  const pendingTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (!entry || entry.status !== 'running') return
    let mounted = true
    const parseTs = (iso: string | null | undefined): number | null => {
      try { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null } catch { return null }
    }
    const nextTs = parseTs(entry.nextRunAt)
    if (nextTs != null) {
      const cur = targetTsRef.current
      // Only pull target earlier immediately; if later, stash as pending until we hit zero
      if (cur == null || nextTs < cur - 500) {
        targetTsRef.current = nextTs
      } else if (nextTs !== cur) {
        pendingTsRef.current = nextTs
      }
    }
    const tick = () => {
      try {
        const now = Date.now()
        let target = targetTsRef.current
        if (target == null) {
          // Fallback to 10s from now if target is missing (UI resilience)
          target = now + 10000
          targetTsRef.current = target
        }
        const remain = Math.max(0, Math.floor(((target as number) - now) / 1000))
        setCountdown(remain)
        if (remain === 0) {
          setProcessing(true)
          setTimeout(() => { if (mounted) setProcessing(false) }, 1500)
          // When reaching zero, commit any pending future target
          const pending = pendingTsRef.current
          if (pending != null) {
            targetTsRef.current = pending
            pendingTsRef.current = null
          } else {
            // Small delay to keep UI stable if backend needs a moment
            targetTsRef.current = now + 2000
          }
        }
      } catch { setCountdown(0) }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { mounted = false; clearInterval(id) }
  }, [entry])

  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/topup_watcher_events/latest?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json().catch(()=>null)
          if (!stop) {
            const ev = j?.event ?? null
            if (ev && entry?.startedAt) {
              try {
                const evTs = Date.parse(String(ev.ts || ev.snapshot_ts || ''))
                const started = Date.parse(String(entry.startedAt))
                if (Number.isFinite(evTs) && Number.isFinite(started) && evTs < started) {
                  setLatest(null)
                } else {
                  setLatest(ev)
                }
              } catch { setLatest(ev) }
            } else {
              setLatest(ev)
            }
          }
        }
      } catch {}
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => { stop = true; clearInterval(id) }
  }, [symbol])

  if (!enabled) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  if (!entry) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>

  const firstConfirm = entry.status === 'running' && entry.lastResult === 'TOP_UP_ELIGIBLE' && Number(entry.debounceCounter) === 1

  const renderLatest = () => {
    if (!latest) return null
    const reasoning = latest.reasoning || latest.reason_code || ''
    const ts = latest.ts || latest.snapshot_ts
    if (latest.action === 'TOP_UP_ELIGIBLE') {
      return <div style={{ color: '#22c55e', fontSize: 9 }}>🟢 Top-up potvrzen {ts ? `· ${new Date(ts).toLocaleTimeString()}` : ''}</div>
    }
    if (latest.action === 'ABORT_TOPUP') {
      return <div style={{ color: '#dc2626', fontSize: 9 }}>🔴 Abort {ts ? `· ${new Date(ts).toLocaleTimeString()}` : ''}</div>
    }
    return <div style={{ color: '#6b7280', fontSize: 9 }}>⚪ Hold {reasoning ? `· ${reasoning}` : ''}</div>
  }

  if (entry.status === 'running') {
  const actionRaw = latest?.action || entry.lastResult || null
  const actionShort = actionRaw === 'TOP_UP_ELIGIBLE' ? 'ELIGIBLE' : actionRaw === 'ABORT_TOPUP' ? 'ABORT' : (actionRaw === 'HOLD' ? 'HOLD' : ((actionRaw === 'TOP_UP_CANDIDATE') ? 'ELIGIBLE' : ((actionRaw === 'ABORT_CANDIDATE') ? 'ABORT' : null)))
  const actionFinal = actionShort || 'HOLD'
  const statusText = `${actionFinal}${latest?.reason_code ? ` (${latest.reason_code})` : ''}`
    const fmtCountdown = () => `${String(Math.floor(countdown / 60)).padStart(2, '0')}:${String(countdown % 60).padStart(2, '0')}`
    const ttlLeft = (() => {
      try { const t = Date.parse(entry.deadlineAt); const now = Date.now(); const sec = Math.max(0, Math.floor((t - now) / 1000)); return sec } catch { return 0 }
    })()
    const fmtTtl = () => `${String(Math.floor(ttlLeft / 60)).padStart(2, '0')}:${String(ttlLeft % 60).padStart(2, '0')}`
    return (
      <div style={{ fontSize: 10, textAlign: 'center' }}>
        <div style={{ color: firstConfirm ? '#f97316' : (actionFinal === 'HOLD' ? '#f59e0b' : (countdown > 0 ? '#f59e0b' : '#3b82f6')) }}>
          {firstConfirm
            ? `🟠 čeká na potvrzení ${fmtCountdown()}`
            : (
              actionFinal === 'HOLD'
                ? `🟡 ${fmtCountdown()}${statusText ? ` · ${statusText}` : ''}`
                : ((processing || countdown <= 0)
                    ? `🔵 processing${statusText ? ` · ${statusText}` : ''}`
                    : `🟡 ${fmtCountdown()}${statusText ? ` · ${statusText}` : ''}`)
              )}
        </div>
        <div style={{ color: '#dc2626', marginTop: 2 }}>
          {`🔴 TTL ${fmtTtl()}`}
        </div>
        {renderLatest()}
      </div>
    )
  }
  if (entry.status === 'completed') {
    const latestAction = latest?.action
    if (latestAction === 'TOP_UP_ELIGIBLE') {
      return (
        <div style={{ fontSize: 10, textAlign: 'center', color: '#22c55e' }}>
          🟢 Confirmed
          {renderLatest()}
        </div>
      )
    }
    if (latestAction === 'ABORT_TOPUP') {
      return (
        <div style={{ fontSize: 10, textAlign: 'center', color: '#dc2626' }}>
          🔴 Abort
          {renderLatest()}
        </div>
      )
    }
    return (
        <div style={{ fontSize: 10, textAlign: 'center', color: '#9ca3af' }}>
          ✅ Completed
          {renderLatest()}
        </div>
    )
  }
  if (entry.lastError) {
    return <span style={{ fontSize: 10, color: '#dc2626' }} title={entry.lastError}>❗ Error</span>
  }
  return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
}

export default WatcherStatus


