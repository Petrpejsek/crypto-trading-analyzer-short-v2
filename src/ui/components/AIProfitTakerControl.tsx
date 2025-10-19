import React from 'react'

type Props = {
  hasPositions: boolean
  lastRunTimestamp: string | null
}

export const AIProfitTakerControl: React.FC<Props> = ({ hasPositions, lastRunTimestamp }) => {
  // AI Profit Taker is manual-only tool - no enable/disable toggle
  // Status based on whether positions exist
  const getStatus = () => {
    if (hasPositions) {
      return { 
        color: '#22c55e', 
        text: '🟢 READY', 
        description: 'AI asistent připraven - klikni na 💰 v grafu pozice'
      }
    }
    return { 
      color: '#f59e0b', 
      text: '🟠 WAITING', 
      description: 'Čeká na otevření SHORT pozice'
    }
  }

  const status = getStatus()

  // Format last run timestamp
  const formatLastRun = () => {
    if (!lastRunTimestamp) return null
    
    try {
      const date = new Date(lastRunTimestamp)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMin = Math.floor(diffMs / 60000)
      
      if (diffMin < 1) return 'právě teď'
      if (diffMin < 60) return `před ${diffMin} min`
      
      const diffHours = Math.floor(diffMin / 60)
      if (diffHours < 24) return `před ${diffHours}h`
      
      return date.toLocaleString('cs-CZ', { 
        day: '2-digit', 
        month: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit' 
      })
    } catch {
      return null
    }
  }

  const lastRunText = formatLastRun()

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong style={{ fontSize: 14, color: status.color }}>
          AI Profit Taker
        </strong>
        <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
          {status.description}
        </div>
        {lastRunText && (
          <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, fontStyle: 'italic' }}>
            Poslední spuštění: {lastRunText}
          </div>
        )}
      </div>
      
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ 
          fontSize: 11, 
          color: status.color,
          fontWeight: 600
        }}>
          {status.text}
        </span>
        
        <div style={{ 
          fontSize: 10, 
          opacity: 0.7,
          background: 'rgba(255,255,255,0.05)',
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          MANUAL
        </div>
      </div>
    </div>
  )
}

export default AIProfitTakerControl

