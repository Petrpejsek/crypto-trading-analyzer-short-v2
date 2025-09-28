import React, { useState, useEffect } from 'react'

type Props = {
  symbol: string
  entry?: StrategyUpdateEntry | null
  enabled?: boolean
}

type StrategyUpdateEntry = {
  symbol: string
  side: 'LONG' | 'SHORT'
  entryPrice: number
  positionSize: number
  currentSL: number | null
  currentTP: number | null
  triggerAt: string  // ISO timestamp when update should trigger
  since: string      // ISO timestamp when position was first detected
  lastCheck: string | null
  checks: number
  status: 'waiting' | 'processing' | 'completed'
  lastError?: string | null
  lastErrorAt?: string | null
}

// Rendering is driven by props; no internal fetching here

// Entry is provided by parent via props.entry

// Simplified: rendering is driven by props; no extra fetching here.

export const StrategyUpdateStatus: React.FC<Props> = ({ symbol, entry: entryProp, enabled }) => {
  const [entry, setEntry] = useState<StrategyUpdateEntry | null>(entryProp ?? null)
  const [countdown, setCountdown] = useState<number>(0)
  const [isEnabled, setIsEnabled] = useState<boolean>(Boolean(enabled))

  // Sync enabled flag from props
  useEffect(() => {
    setIsEnabled(Boolean(enabled))
  }, [enabled])

  // Receive entry via props
  useEffect(() => {
    setEntry(entryProp ?? null)
  }, [entryProp, symbol])

  // Update countdown every second
  useEffect(() => {
    if (!entry || entry.status !== 'waiting') return

    const updateCountdown = () => {
      try {
        const triggerTime = new Date(entry.triggerAt).getTime()
        const now = Date.now()
        const remaining = Math.max(0, Math.floor((triggerTime - now) / 1000))
        setCountdown(remaining)
      } catch {
        setCountdown(0)
      }
    }

    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    
    return () => clearInterval(interval)
  }, [entry])

  // Format countdown as MM:SS
  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Don't show anything if strategy updater is disabled
  if (!isEnabled) {
    return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  }

  // No entry yet -> show nothing; countdown will appear once registry entry exists with triggerAt
  if (!entry) { return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span> }

  // Show status based on entry state
  switch (entry.status) {
    case 'waiting':
      if (countdown > 0) {
        return (
          <div style={{ fontSize: 10, textAlign: 'center' }}>
            <div style={{ color: '#f59e0b' }}>🟡 {formatCountdown(countdown)}</div>
            <div style={{ color: '#6b7280', fontSize: 8 }}>strategy update</div>
          </div>
        )
      } else {
        return (
          <span style={{ fontSize: 10, color: '#f59e0b' }} title="Strategy update is due">
            🟡 Due
          </span>
        )
      }
    case 'processing':
      return (
        <div style={{ fontSize: 10, textAlign: 'center' }}>
          <div style={{ color: '#3b82f6' }}>🔵 Processing</div>
          <div style={{ color: '#6b7280', fontSize: 8 }}>updating TP/SL</div>
        </div>
      )
    case 'completed':
      return (
        <span style={{ fontSize: 10, color: '#10b981' }} title="Strategy update completed">
          ✅ Updated
        </span>
      )
    default:
      // Show error hint if any
      if (entry.lastError) {
        return (
          <span style={{ fontSize: 10, color: '#dc2626' }} title={entry.lastErrorAt ? `${new Date(entry.lastErrorAt).toLocaleTimeString()} · ${entry.lastError}` : entry.lastError}>
            ❗ Error
          </span>
        )
      }
      return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  }
}
