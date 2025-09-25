import React, { useEffect, useState } from 'react'

type Props = {
  hasPositions: boolean
  hasActiveTimers: boolean
}

export const ProfitTakerControl: React.FC<Props> = ({ hasPositions, hasActiveTimers }) => {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('profit_taker_enabled') === '1' } catch { return true }
  })
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    const sync = async () => {
      try {
        const r = await fetch('/api/profit_taker_toggle')
        if (r.ok) {
          const j = await r.json()
          const b = Boolean(j?.enabled)
          if (b !== enabled) {
            setEnabled(b)
            try { localStorage.setItem('profit_taker_enabled', b ? '1' : '0') } catch {}
          }
        }
      } catch {}
    }
    sync()
  }, [])

  const handleToggle = async (val: boolean) => {
    setSyncing(true)
    setEnabled(val)
    try { localStorage.setItem('profit_taker_enabled', val ? '1' : '0') } catch {}
    try { await fetch('/api/profit_taker_toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: val }) }) } catch {}
    setSyncing(false)
  }

  const status = (() => {
    if (!enabled) return { color: '#ef4444', text: '🔴 VYPNUTO', desc: 'Profit Taker je vypnutý' }
    if (hasActiveTimers) return { color: '#22c55e', text: '🟢 AKTIVNÍ', desc: 'Běží 5m sloty na pozicích' }
    if (hasPositions) return { color: '#f59e0b', text: '🟠 ČEKÁ', desc: 'Pozice otevřené, čeká na slot' }
    return { color: '#f59e0b', text: '🟠 WAITING', desc: 'Čeká na otevření pozice' }
  })()

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong style={{ fontSize: 14, color: status.color }}>Profit Taker</strong>
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
  )
}

export default ProfitTakerControl


