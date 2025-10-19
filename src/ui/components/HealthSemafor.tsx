// Health Semafor - Visual Border Wrapper
// Wraps TradingViewChart with colored border and health badge

import React, { useMemo, useEffect, useState } from 'react'

type HealthOutput = {
  health_pct: number
  success_prob_pct: number
  tp_hit_probs_pct: {
    tp1: number
    tp2: number
    tp3: number
  }
  sl_touch_prob_pct: number
  bias_score: number
  momentum_score: number
  bias_label: string
  momentum_label: string
  reasons: string[]
  updated_at_utc: string
}

type HealthWorkerEntry = {
  symbol: string
  status: 'waiting' | 'processing' | 'completed'
  nextRunAt: string
  lastRunAt: string | null
  tickCount: number
}

type HealthSemaforProps = {
  symbol: string
  health: number
  isStale?: boolean
  staleReason?: string
  fullOutput?: HealthOutput | null
  workerEntry?: HealthWorkerEntry | null
  workerEnabled?: boolean
  children: React.ReactNode
}

const COLORS = {
  green: '#10b981',
  orange: '#f59e0b',
  red: '#ef4444',
  grey: '#6b7280'
}

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString)
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return isoString
  }
}

function useCountdown(nextRunAt: string | null | undefined, status: string | null | undefined): string {
  const [countdown, setCountdown] = useState<string>('—')
  
  useEffect(() => {
    if (!nextRunAt || status !== 'waiting') {
      if (status === 'processing') {
        setCountdown('Processing...')
      } else {
        setCountdown('—')
      }
      return
    }
    
    const updateCountdown = () => {
      try {
        const now = Date.now()
        const target = new Date(nextRunAt).getTime()
        const diff = target - now
        
        if (diff <= 0) {
          setCountdown('DUE')
          return
        }
        
        const seconds = Math.floor(diff / 1000)
        const minutes = Math.floor(seconds / 60)
        const secs = seconds % 60
        
        setCountdown(`${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`)
      } catch {
        setCountdown('—')
      }
    }
    
    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    
    return () => clearInterval(interval)
  }, [nextRunAt, status])
  
  return countdown
}

export const HealthSemafor: React.FC<HealthSemaforProps> = ({
  symbol,
  health,
  isStale,
  staleReason,
  fullOutput,
  workerEntry,
  workerEnabled,
  children
}) => {
  const borderColor = useMemo(() => {
    if (!fullOutput || isStale) return COLORS.grey
    if (fullOutput.hard_fail) return COLORS.red
    if (health >= 70) return COLORS.green
    if (health >= 40) return COLORS.orange
    return COLORS.red
  }, [fullOutput, isStale, health])
  
  const countdown = useCountdown(workerEntry?.nextRunAt, workerEntry?.status)
  
  const tooltipContent = useMemo(() => {
    if (!fullOutput) return null
    
    const lines: string[] = []
    lines.push(`Symbol: ${symbol}`)
    lines.push('')
    lines.push(`Health: ${fullOutput.health_pct}%`)
    lines.push(`Success: ${fullOutput.success_prob_pct}%`)
    lines.push(`TP1: ${fullOutput.tp_hit_probs_pct.tp1}% | TP2: ${fullOutput.tp_hit_probs_pct.tp2}% | TP3: ${fullOutput.tp_hit_probs_pct.tp3}% | SL: ${fullOutput.sl_touch_prob_pct}%`)
    lines.push('')
    lines.push(`Bias: ${fullOutput.bias_label} (${fullOutput.bias_score})`)
    lines.push(`Momentum: ${fullOutput.momentum_label} (${fullOutput.momentum_score})`)
    lines.push('')
    if (fullOutput.reasons.length > 0) {
      lines.push('Reasons:')
      fullOutput.reasons.forEach(r => lines.push(`• ${r}`))
      lines.push('')
    }
    lines.push(`Updated: ${formatTimestamp(fullOutput.updated_at_utc)}`)
    
    return lines.join('\n')
  }, [fullOutput, symbol])
  
  const statusText = useMemo(() => {
    if (!workerEnabled) return 'Health Monitor: Disabled'
    if (isStale) return `Health Monitor: STALE (${staleReason || 'unknown'})`
    if (!fullOutput) return 'Health Monitor: Waiting...'
    return null
  }, [workerEnabled, isStale, staleReason, fullOutput])
  
  return (
    <div style={{ position: 'relative', border: `3px solid ${borderColor}`, borderRadius: '6px', overflow: 'visible', display: 'inline-block', width: 'fit-content' }}>
      {/* Wrapped content (TradingViewChart) */}
      {children}
      
      {/* Health Badge - positioned INSIDE border but ABOVE content */}
      {fullOutput && !isStale && (
        <div
          style={{
            position: 'absolute',
            bottom: '110px',
            right: '12px',
            zIndex: 100,
            background: 'rgba(0, 0, 0, 0.90)',
            backdropFilter: 'blur(8px)',
            borderRadius: '6px',
            padding: '10px 14px',
            display: 'flex',
            gap: '14px',
            alignItems: 'center',
            fontSize: '12px',
            color: '#fff',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            cursor: 'pointer',
            border: `1px solid ${borderColor}40`
          }}
          title={tooltipContent || undefined}
        >
          {/* Left: Health & Success */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ fontWeight: 700, color: borderColor, fontSize: '13px' }}>
              Health: {fullOutput.health_pct}%
            </div>
            <div style={{ fontSize: '12px', opacity: 0.95, fontWeight: 600 }}>
              Success: {fullOutput.success_prob_pct}%
            </div>
          </div>
          
          {/* Divider */}
          <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.25)' }} />
          
          {/* Right: Countdown */}
          {workerEntry && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-end' }}>
              <div style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '14px', color: borderColor }}>
                {countdown}
              </div>
              <div style={{ fontSize: '10px', opacity: 0.8, fontWeight: 500 }}>
                next check
              </div>
            </div>
          )}
        </div>
      )}
      
      {/* Status text when no data */}
      {statusText && (
        <div
          style={{
            position: 'absolute',
            bottom: '110px',
            right: '12px',
            zIndex: 100,
            background: 'rgba(0, 0, 0, 0.85)',
            borderRadius: '6px',
            padding: '10px 14px',
            fontSize: '12px',
            color: COLORS.grey,
            fontWeight: 600
          }}
        >
          {statusText}
        </div>
      )}
    </div>
  )
}

