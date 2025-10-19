// Health Badge Mini - Compact badge for tables
// Shows health % with trend arrow and optional success indicator

import React, { useMemo } from 'react'

type HealthBadgeMiniProps = {
  health: number
  prevHealth?: number
  success?: number
  isStale?: boolean
  size?: 'small' | 'medium'
}

const COLORS = {
  green: '#10b981',
  orange: '#f59e0b',
  red: '#ef4444',
  grey: '#6b7280'
}

function getHealthColor(health: number): string {
  if (health >= 70) return COLORS.green
  if (health >= 40) return COLORS.orange
  return COLORS.red
}

function getTrendArrow(health: number, prevHealth: number | undefined): string {
  if (prevHealth === undefined) return ''
  const diff = health - prevHealth
  if (diff > 2) return ' ↗'
  if (diff < -2) return ' ↘'
  return ' →'
}

export const HealthBadgeMini: React.FC<HealthBadgeMiniProps> = ({
  health,
  prevHealth,
  success,
  isStale,
  size = 'small'
}) => {
  const color = useMemo(() => {
    if (isStale) return COLORS.grey
    return getHealthColor(health)
  }, [health, isStale])
  
  const trendArrow = useMemo(() => {
    if (isStale) return ''
    return getTrendArrow(health, prevHealth)
  }, [health, prevHealth, isStale])
  
  const showSuccess = success !== undefined && success !== health
  
  const fontSize = size === 'small' ? '11px' : '13px'
  const padding = size === 'small' ? '3px 6px' : '4px 8px'
  
  if (isStale) {
    return (
      <span
        style={{
          display: 'inline-block',
          fontSize,
          fontWeight: 600,
          color: COLORS.grey,
          padding,
          borderRadius: '4px',
          background: 'rgba(107, 114, 128, 0.1)',
          fontFamily: 'monospace'
        }}
      >
        STALE
      </span>
    )
  }
  
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize,
        fontWeight: 600,
        color,
        padding,
        borderRadius: '4px',
        background: `${color}15`,
        fontFamily: 'monospace'
      }}
    >
      {health}%{trendArrow}
      {showSuccess && (
        <span style={{ fontSize: '10px', opacity: 0.8 }}>
          •{success}
        </span>
      )}
    </span>
  )
}

