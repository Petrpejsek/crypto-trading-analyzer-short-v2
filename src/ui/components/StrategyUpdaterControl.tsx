import React, { useState, useEffect } from 'react'

type Props = {
  hasPositions: boolean
  hasActiveCountdowns: boolean
}

export const StrategyUpdaterControl: React.FC<Props> = ({ hasPositions, hasActiveCountdowns }) => {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('strategy_updater_enabled') === '1' } catch { return false }
  })
  const [syncing, setSyncing] = useState(false)

  // Sync with backend on mount
  useEffect(() => {
    const syncWithBackend = async () => {
      try {
        const response = await fetch('/api/strategy_updater_toggle')
        if (response.ok) {
          const data = await response.json()
          const backendEnabled = Boolean(data.enabled)
          
          if (backendEnabled !== enabled) {
            setEnabled(backendEnabled)
            localStorage.setItem('strategy_updater_enabled', backendEnabled ? '1' : '0')
          }
        }
      } catch (e) {
        console.warn('[STRATEGY_UPDATER_SYNC_ERR]', e)
      }
    }
    
    syncWithBackend()
  }, [])

  const handleToggle = async (newValue: boolean) => {
    setSyncing(true)
    setEnabled(newValue)
    localStorage.setItem('strategy_updater_enabled', newValue ? '1' : '0')
    
    try {
      await fetch('/api/strategy_updater_toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newValue })
      })
    } catch (e) {
      console.warn('[STRATEGY_UPDATER_SYNC_ERR]', e)
    } finally {
      setSyncing(false)
    }
  }

  // Removed manual start buttons. Strategy Updater is fully automatic:
  // - Enabled/disabled via toggle
  // - Starts on position open (WS-detected)
  // - 5min cadence handled server-side

  // Determine status based on enabled state and position activity
  const getStatus = () => {
    if (!enabled) return { color: '#ef4444', text: '🔴 VYPNUTO', description: 'Strategy Updater je vypnutý' }
    if (hasActiveCountdowns) return { color: '#22c55e', text: '🟢 AKTIVNÍ', description: 'Běží countdown u pozic' }
    if (hasPositions) return { color: '#f59e0b', text: '🟠 ČEKÁ', description: 'Pozice otevřené, čeká na trigger' }
    return { color: '#f59e0b', text: '🟠 WAITING', description: 'Čeká na otevření pozice' }
  }

  const status = getStatus()

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong style={{ fontSize: 14, color: status.color }}>
          Strategy Updater
        </strong>
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
          {status.description}
        </div>
        {/* No transient start messages – auto mode only */}
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ 
          fontSize: 11, 
          color: status.color,
          fontWeight: 600
        }}>
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

        {/* Manual run controls removed by design */}
      </div>
    </div>
  )
}
