import React from 'react'

export type WsHealth = {
  connected: boolean
  streams: number
  lastClosedAgeMsByKey: Record<string, number | null>
}

type Props = {
  feedsOk?: boolean | null
  snapshotMs?: number | null
  featuresMs?: number | null
  symbols?: number | null
  ws?: WsHealth | null
}

export const StatusPills: React.FC<Props> = ({ feedsOk, snapshotMs, featuresMs, symbols, ws }) => {
  const feedsClass = feedsOk ? 'pill ok' : feedsOk == null ? 'pill warn' : 'pill err'
  const wsLabel = ws ? (ws.connected ? `WS: ${ws.streams} streams` : 'WS: disconnected') : 'WS: —'
  const wsClass = ws ? (ws.connected ? 'pill ok' : 'pill err') : 'pill'
  const profile = (()=>{ try { const cfg = (window as any).APP_CFG || {}; return cfg.profile || 'LEAN' } catch { return 'LEAN' } })()
  const profileTitle = 'TopK=8, compact payload, diag off'
  return (
    <div className="row wrap gap-8 mb-12">
      <span className={feedsClass}>Feeds: {feedsOk ? 'OK' : feedsOk == null ? '—' : 'ERROR'}</span>
      <span className="pill">Snapshot: {snapshotMs != null ? `${Math.round(snapshotMs)} ms` : '—'}</span>
      <span className="pill">Features: {featuresMs != null ? `${Math.round(featuresMs)} ms` : '—'}</span>
      <span className="pill">Symbols: {symbols ?? '—'}</span>
      <span className={wsClass}>{wsLabel}</span>
      <span className="pill" title={profileTitle}>Profile: {profile}</span>
    </div>
  )
}


