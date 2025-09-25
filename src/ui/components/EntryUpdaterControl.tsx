import React, { useEffect, useState } from 'react'

type Props = {
  hasOpenEntries: boolean
  hasActiveTimers: boolean
}

const BLUE = '#3b82f6'
const GRAY = '#6b7280'
const RED = '#ef4444'
const GREEN = '#22c55e'
const AMBER = '#f59e0b'

export const EntryUpdaterControl: React.FC<Props> = ({ hasOpenEntries, hasActiveTimers }) => {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('entry_updater_enabled') === '1' } catch { return false }
  })
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    const syncWithBackend = async () => {
      try {
        const response = await fetch('/api/entry_updater_toggle')
        if (response.ok) {
          const data = await response.json()
          const backendEnabled = Boolean(data.enabled)
          if (backendEnabled !== enabled) {
            setEnabled(backendEnabled)
            localStorage.setItem('entry_updater_enabled', backendEnabled ? '1' : '0')
          }
        }
      } catch (e) {
        console.warn('[ENTRY_UPDATER_SYNC_ERR]', e)
      }
    }
    syncWithBackend()
  }, [])

  const handleToggle = async (newValue: boolean) => {
    setSyncing(true)
    setEnabled(newValue)
    localStorage.setItem('entry_updater_enabled', newValue ? '1' : '0')
    try {
      await fetch('/api/entry_updater_toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newValue })
      })
    } catch (e) {
      console.warn('[ENTRY_UPDATER_SYNC_ERR]', e)
    } finally {
      setSyncing(false)
    }
  }

  const getStatus = () => {
    if (!enabled) return { color: RED, text: '🔴 VYPNUTO', description: 'Entry Updater je vypnutý' }
    if (hasActiveTimers) return { color: GREEN, text: '🟢 AKTIVNÍ', description: 'Běží 5min kontrola čekajících entry' }
    if (hasOpenEntries) return { color: AMBER, text: '🟠 ČEKÁ', description: 'Otevřené ENTRY, čeká na další kolo' }
    return { color: GRAY, text: '—', description: 'Žádné čekající ENTRY' }
  }

  const status = getStatus()

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong style={{ fontSize: 14, color: BLUE }}>
          Entry Updater
        </strong>
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2, color: status.color }}>
          {status.description}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: status.color, fontWeight: 600 }}>
          {status.text}
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={syncing}
            onChange={(e) => handleToggle(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ fontSize: 12, opacity: syncing ? 0.5 : 1 }}>
            {syncing ? 'Sync...' : (enabled ? 'ON' : 'OFF')}
          </span>
        </label>
      </div>
    </div>
  )
}

export default EntryUpdaterControl



