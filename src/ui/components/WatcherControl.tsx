import React, { useEffect, useState } from 'react'

type Props = {
  hasPositions: boolean
  hasActiveTimers: boolean
}

const WatcherControl: React.FC<Props> = ({ hasPositions, hasActiveTimers }) => {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('topup_watcher_enabled') !== '0' } catch { return true }
  })
  const [syncing, setSyncing] = useState(false)
  // Multiplier input moved to Top-Up Executor Control

  useEffect(() => {
    const sync = async () => {
      try {
        const r = await fetch('/api/topup_watcher_toggle')
        if (r.ok) {
          const j = await r.json()
          const on = Boolean(j?.enabled)
          if (on !== enabled) {
            setEnabled(on)
            try { localStorage.setItem('topup_watcher_enabled', on ? '1' : '0') } catch {}
          }
        }
      } catch {}
    }
    sync()
  }, [])

  const handleToggle = async (val: boolean) => {
    setSyncing(true)
    setEnabled(val)
    try { localStorage.setItem('topup_watcher_enabled', val ? '1' : '0') } catch {}
    try {
      await fetch('/api/topup_watcher_toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: val })
      })
    } catch {}
    setSyncing(false)
  }

  // Stabilní indikace: AKTIVNÍ pouze pokud jsou otevřené pozice, jinak WAITING
  const status = (() => {
    if (!enabled) return { color: '#ef4444', text: '🔴 VYPNUTO', desc: 'Watcher je vypnutý' }
    if (hasPositions) return { color: '#22c55e', text: '🟢 AKTIVNÍ', desc: 'Pozice aktivní – watcher monitoruje' }
    return { color: '#f59e0b', text: '🟠 WAITING', desc: 'Čeká na pilotní pozici' }
  })()

  // no multiplier handler here

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong style={{ fontSize: 14, color: status.color }}>Watcher</strong>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{status.desc}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: status.color, fontWeight: 600 }}>{status.text}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={enabled} disabled={syncing} onChange={e => handleToggle(e.target.checked)} style={{ cursor: 'pointer' }} />
            <span style={{ fontSize: 12, opacity: syncing ? 0.5 : 1 }}>{syncing ? 'Sync...' : (enabled ? 'ON' : 'OFF')}</span>
          </label>
        </div>
      </div>
      {/* Multiplier field moved to Top-Up Executor Control */}
    </div>
  )
}

export default WatcherControl


