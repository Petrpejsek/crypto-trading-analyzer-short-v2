import React, { useEffect, useMemo, useState } from 'react'
import { writeClipboard } from '../utils/clipboard'

type AiAssistantKey = 
  | 'entry_strategy_conservative' 
  | 'entry_strategy_aggressive' 
  | 'entry_risk_manager' 
  | 'strategy_updater' 
  | 'hot_screener' 
  | 'reactive_entry_assistant'
  | 'ai_profit_taker'

type AiEvent = {
  id: string
  ts: string
  assistantKey: AiAssistantKey
  symbol?: string | null
  raw_request?: any | null
  raw_response?: any | null
}

/**
 * JsonBlock - Formatted JSON display with copy functionality
 */
const JsonBlock: React.FC<{ data: any; maxHeight?: number }> = ({ data, maxHeight = 240 }) => {
  const text = useMemo(() => {
    try {
      return JSON.stringify(data ?? null, null, 2)
    } catch {
      return String(data)
    }
  }, [data])
  
  return (
    <pre style={{ 
      maxHeight, 
      overflow: 'auto', 
      fontSize: 11, 
      background: 'rgba(255,255,255,0.02)', 
      padding: 8, 
      border: '1px solid var(--border, #333)', 
      borderRadius: 6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxWidth: '100%',
      margin: 0
    }}>
      {text}
    </pre>
  )
}

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * DevAiOverview - Real-time AI communication monitor
 * Displays raw request/response payloads from OpenAI via SSE
 * Uses SINGLE multiplexed SSE connection for all assistants (no browser connection limit issues)
 */
export const DevAiOverview: React.FC = () => {
  // Checkbox filters for each assistant
  // Client-side filtering - all events come through one SSE connection
  const [enabledCons, setEnabledCons] = useState(false)
  const [enabledAggr, setEnabledAggr] = useState(false)
  const [enabledRisk, setEnabledRisk] = useState(false)
  const [enabledSU, setEnabledSU] = useState(false)
  const [enabledHot, setEnabledHot] = useState(false)
  const [enabledPT, setEnabledPT] = useState(false)
  const [enabledReactive, setEnabledReactive] = useState(false)
  
  // Connection status
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  
  // Symbol filter
  const [symbolFilter, setSymbolFilter] = useState('')
  
  // Event buffer (max 200)
  const [events, setEvents] = useState<AiEvent[]>([])
  
  // Copy feedback
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  
  // Load token from env
  const token = useMemo(() => {
    try {
      return (import.meta as any)?.env?.VITE_DEV_AUTH_TOKEN || 'dev-secret-token'
    } catch {
      return 'dev-secret-token'
    }
  }, [])
  
  // Copy helper with feedback
  const copy = async (data: any) => {
    try {
      const text = JSON.stringify(data, null, 2)
      await writeClipboard(text)
      setCopyFeedback('Copied!')
      setTimeout(() => setCopyFeedback(null), 2000)
    } catch (err: any) {
      setCopyFeedback(`Error: ${err?.message || err}`)
      setTimeout(() => setCopyFeedback(null), 3000)
    }
  }
  
  // Check if event should be shown based on enabled filters
  const shouldShowEvent = (assistantKey: AiAssistantKey): boolean => {
    switch (assistantKey) {
      case 'entry_strategy_conservative': return enabledCons
      case 'entry_strategy_aggressive': return enabledAggr
      case 'entry_risk_manager': return enabledRisk
      case 'strategy_updater': return enabledSU
      case 'hot_screener': return enabledHot
      case 'ai_profit_taker': return enabledPT
      case 'reactive_entry_assistant': return enabledReactive
      default: return false
    }
  }
  
  // SSE setup - SINGLE multiplexed connection for ALL assistants
  useEffect(() => {
    // Only connect if at least one assistant is enabled
    const anyEnabled = enabledCons || enabledAggr || enabledRisk || enabledSU || enabledHot || enabledPT || enabledReactive
    
    if (!anyEnabled) {
      setConnectionStatus('disconnected')
      return
    }
    
    setConnectionStatus('connecting')
    
    try {
      const url = `/dev/ai-stream/all?token=${encodeURIComponent(token)}`
      const es = new EventSource(url)
      
      es.onopen = () => {
        setConnectionStatus('connected')
      }
      
      es.onmessage = (ev) => {
        try {
          const e = JSON.parse(ev.data) as AiEvent
          // Client-side filtering based on enabled checkboxes
          if (shouldShowEvent(e.assistantKey)) {
            setEvents(prev => [...prev.slice(-199), e]) // Keep last 200
          }
        } catch (err) {
          console.error('[AI_OVERVIEW_PARSE_ERROR]', err)
        }
      }
      
      es.onerror = (err) => {
        console.error('[AI_OVERVIEW_SSE_ERROR]', err)
        setConnectionStatus('error')
        // EventSource auto-reconnects, update status when it does
      }
      
      // Cleanup on unmount or filter change
      return () => {
        try {
          es.close()
          setConnectionStatus('disconnected')
        } catch {}
      }
    } catch (err) {
      console.error('[AI_OVERVIEW_SSE_INIT_ERROR]', err)
      setConnectionStatus('error')
    }
  }, [enabledCons, enabledAggr, enabledRisk, enabledSU, enabledHot, enabledPT, enabledReactive, token])
  
  // Filtered events
  const filtered = useMemo(() => {
    const sym = symbolFilter.trim().toUpperCase()
    return events.filter(e => {
      if (sym && String(e.symbol || '').toUpperCase() !== sym) return false
      return true
    })
  }, [events, symbolFilter])
  
  // Reverse chronology (newest first)
  const reversed = useMemo(() => [...filtered].reverse(), [filtered])
  
  return (
    <div style={{ 
      padding: 20, 
      maxWidth: 1400, 
      margin: '0 auto',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      background: '#0a0a0a',
      minHeight: '100vh',
      color: '#fff'
    }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
            AI Overview <span style={{ fontSize: 14, opacity: 0.6, fontWeight: 400 }}>(DEV ONLY)</span>
          </h1>
          {/* Connection Status Indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            background: connectionStatus === 'connected' ? 'rgba(34, 197, 94, 0.1)' :
                       connectionStatus === 'connecting' ? 'rgba(59, 130, 246, 0.1)' :
                       connectionStatus === 'error' ? 'rgba(239, 68, 68, 0.1)' :
                       'rgba(107, 114, 128, 0.1)',
            color: connectionStatus === 'connected' ? '#22c55e' :
                   connectionStatus === 'connecting' ? '#3b82f6' :
                   connectionStatus === 'error' ? '#ef4444' :
                   '#6b7280',
            border: `1px solid ${
              connectionStatus === 'connected' ? 'rgba(34, 197, 94, 0.3)' :
              connectionStatus === 'connecting' ? 'rgba(59, 130, 246, 0.3)' :
              connectionStatus === 'error' ? 'rgba(239, 68, 68, 0.3)' :
              'rgba(107, 114, 128, 0.3)'
            }`
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: connectionStatus === 'connected' ? '#22c55e' :
                         connectionStatus === 'connecting' ? '#3b82f6' :
                         connectionStatus === 'error' ? '#ef4444' :
                         '#6b7280',
              animation: connectionStatus === 'connecting' ? 'pulse 2s infinite' : 'none'
            }} />
            {connectionStatus === 'connected' ? 'CONNECTED' :
             connectionStatus === 'connecting' ? 'CONNECTING...' :
             connectionStatus === 'error' ? 'ERROR' :
             'DISCONNECTED'}
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.7 }}>
          Real-time monitoring of AI request/response payloads from OpenAI (Multiplexed SSE - Single Connection)
        </p>
      </div>
      
      {/* Controls */}
      <div style={{ 
        marginBottom: 20, 
        padding: 16, 
        background: 'rgba(255,255,255,0.03)', 
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.1)'
      }}>
        {/* Assistant filters */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.8 }}>
            Assistants:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledCons} 
                onChange={e => setEnabledCons(e.target.checked)} 
              />
              conservative
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledAggr} 
                onChange={e => setEnabledAggr(e.target.checked)} 
              />
              aggressive
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledRisk} 
                onChange={e => setEnabledRisk(e.target.checked)} 
              />
              risk_manager
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledSU} 
                onChange={e => setEnabledSU(e.target.checked)} 
              />
              strategy_updater
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledHot} 
                onChange={e => setEnabledHot(e.target.checked)} 
              />
              hot_screener
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={enabledPT} 
                onChange={e => setEnabledPT(e.target.checked)} 
              />
              ai_profit_taker
            </label>
            <label style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 6, 
              fontSize: 12, 
              cursor: 'pointer'
            }}>
              <input 
                type="checkbox" 
                checked={enabledReactive} 
                onChange={e => setEnabledReactive(e.target.checked)} 
              />
              reactive_entry
            </label>
          </div>
        </div>
        
        {/* Symbol filter and actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <input 
            value={symbolFilter} 
            onChange={e => setSymbolFilter(e.target.value.toUpperCase())} 
            placeholder="SYMBOL (optional)" 
            style={{ 
              fontSize: 12, 
              padding: '6px 10px', 
              width: 160,
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 4,
              color: '#fff'
            }} 
          />
          <button
            onClick={() => setEvents([])}
            style={{
              fontSize: 12,
              padding: '6px 12px',
              background: 'rgba(220, 38, 38, 0.1)',
              border: '1px solid rgba(220, 38, 38, 0.3)',
              borderRadius: 4,
              color: '#ef4444',
              cursor: 'pointer'
            }}
          >
            Clear
          </button>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            Events: {filtered.length} / {events.length}
          </div>
          {copyFeedback && (
            <div style={{ fontSize: 12, color: '#22c55e' }}>
              {copyFeedback}
            </div>
          )}
        </div>
      </div>
      
      {/* Events list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {reversed.length === 0 ? (
          <div style={{ 
            padding: 40, 
            textAlign: 'center', 
            opacity: 0.5,
            fontSize: 14
          }}>
            No events yet. Enable assistants and trigger AI analysis.
          </div>
        ) : (
          reversed.map(e => (
            <div 
              key={e.id} 
              style={{ 
                padding: 16, 
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 8
              }}
            >
              {/* Event header */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: 12,
                flexWrap: 'wrap',
                gap: 8
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13, color: '#60a5fa' }}>
                    {e.assistantKey}
                  </strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {e.symbol || '—'}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                </div>
              </div>
              
              {/* Raw request */}
              {e.raw_request ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: '#fbbf24' }}>
                      Input (raw_request)
                    </div>
                    <button
                      onClick={() => copy(e.raw_request)}
                      style={{
                        fontSize: 11,
                        padding: '4px 8px',
                        background: 'rgba(251, 191, 36, 0.1)',
                        border: '1px solid rgba(251, 191, 36, 0.3)',
                        borderRadius: 4,
                        color: '#fbbf24',
                        cursor: 'pointer'
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <JsonBlock data={e.raw_request} maxHeight={300} />
                </div>
              ) : null}
              
              {/* Raw response */}
              {e.raw_response ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: '#34d399' }}>
                      Output (raw_response)
                    </div>
                    <button
                      onClick={() => copy(e.raw_response)}
                      style={{
                        fontSize: 11,
                        padding: '4px 8px',
                        background: 'rgba(52, 211, 153, 0.1)',
                        border: '1px solid rgba(52, 211, 153, 0.3)',
                        borderRadius: 4,
                        color: '#34d399',
                        cursor: 'pointer'
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <JsonBlock data={e.raw_response} maxHeight={300} />
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

