import React from 'react'

type Props = {
  feedsOk: boolean
  latencyMs: number
  symbolsLoaded: number
  featuresMs?: number | null
  breadthPct?: number | null
  ageMs?: number
  onRun?: () => void
}

export const SnapshotBanner: React.FC<Props> = ({ feedsOk, latencyMs, symbolsLoaded, featuresMs, breadthPct, ageMs, onRun }) => {
  const bg = feedsOk ? '#e6ffed' : '#fff5f5'
  const color = feedsOk ? '#03543f' : '#9b1c1c'
  const border = feedsOk ? '#31c48d' : '#f98080'
  const stale2 = typeof ageMs === 'number' && ageMs >= 2*60_000 && ageMs < 5*60_000
  const stale5 = typeof ageMs === 'number' && ageMs >= 5*60_000
  const staleColor = stale5 ? '#9b1c1c' : (stale2 ? '#92400e' : null)
  const staleBg = stale5 ? '#fff5f5' : (stale2 ? '#fffbea' : null)
  const staleBorder = stale5 ? '#f98080' : (stale2 ? '#faca15' : null)
  const warnBox = (stale2 || stale5) ? (
    <span style={{ padding:'2px 6px', borderRadius:6, background: staleBg!, color: staleColor!, border: `1px solid ${staleBorder}` }}>
      {stale5 ? 'Snapshot is 5+ min old — execution disabled' : 'Snapshot is 2+ min old — consider Run'}
    </span>
  ) : null
  return (
    <div style={{
      background: bg,
      color,
      border: `1px solid ${border}`,
      borderRadius: 8,
      padding: '10px 12px',
      display: 'flex',
      gap: 16,
      alignItems: 'center',
      fontSize: 14,
      marginBottom: 12,
      flexWrap: 'wrap'
    }}>
      <strong>{feedsOk ? 'Feeds OK' : 'Feeds STALE/ERROR'}</strong>
      <span>Snapshot duration: {Math.round(latencyMs)} ms</span>
      <span>Symbols loaded: {symbolsLoaded}</span>
      <span>Features: {featuresMs != null ? Math.round(featuresMs) : '—'} ms</span>
      <span>Breadth: {breadthPct != null ? `${breadthPct}%` : '—'}</span>
      {ageMs != null ? <span>Age: {Math.floor(ageMs/1000)}s</span> : null}
      {warnBox}
      {onRun ? (<button className="btn" style={{ marginLeft: 'auto' }} onClick={onRun}>Run now</button>) : null}
    </div>
  )
}

