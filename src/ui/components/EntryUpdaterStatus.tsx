import React, { useEffect, useState } from 'react'

type EntryOrderTrack = {
  symbol: string
  orderId: number
  triggerAt: string
  checks: number
  lastError?: string | null
  status?: 'waiting' | 'processing' | 'completed' | 'unknown'
}

type Props = {
  symbol: string
  entry: EntryOrderTrack | null
  enabled: boolean
}

export const EntryUpdaterStatus: React.FC<Props> = ({ symbol, entry, enabled }) => {
  const [countdown, setCountdown] = useState<number>(0)

  useEffect(() => {
    if (!entry || entry.status === 'completed') return
    const update = () => {
      try {
        const t = new Date(entry.triggerAt).getTime()
        const now = Date.now()
        setCountdown(Math.max(0, Math.floor((t - now) / 1000)))
      } catch { setCountdown(0) }
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [entry])

  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  }

  if (!enabled) return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  if (!entry) return <span style={{ fontSize: 10, color: '#60a5fa' }}>🔵 EU</span>

  switch (entry.status) {
    case 'waiting':
      return (
        <div style={{ fontSize: 10, textAlign: 'center' }}>
          <div style={{ color: '#60a5fa' }}>🔵 {countdown > 0 ? fmt(countdown) : 'Due'}</div>
          <div style={{ color: '#6b7280', fontSize: 8 }}>entry update</div>
        </div>
      )
    case 'processing':
      return (
        <div style={{ fontSize: 10, textAlign: 'center' }}>
          <div style={{ color: '#3b82f6' }}>🔵 Processing</div>
          <div style={{ color: '#6b7280', fontSize: 8 }}>reposition/cancel</div>
        </div>
      )
    case 'completed':
      return <span style={{ fontSize: 10, color: '#22c55e' }}>✅ Updated</span>
    default:
      if (entry.lastError) {
        return <span style={{ fontSize: 10, color: '#dc2626' }} title={entry.lastError}>❗ Error</span>
      }
      return <span style={{ fontSize: 10, color: '#6b7280' }}>—</span>
  }
}

export default EntryUpdaterStatus



