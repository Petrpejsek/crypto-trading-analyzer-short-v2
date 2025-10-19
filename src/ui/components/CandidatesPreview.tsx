import React from 'react'
import { writeClipboard } from '../utils/clipboard'
type Candidate = {
  symbol: string
  tier: 'SCOUT' | 'WATCH' | 'ALERT' | 'HOT'
  score: number
  atrPctH1: number
  emaOrderH1: string
  rsiM15?: number
  rsiH1?: number
  liquidityUsd: number
  // New fields
  archetype?: 'loser_cont' | 'loser_fade' | 'overbought_blowoff' | 'mixed'
  basket?: 'Prime' | 'Strong Watch' | 'Speculative'
  reason?: string
  ret24hPct?: number
  ret60mPct?: number
  ret15mPct?: number
  vwapRelM15?: number
  posInH1RangePct?: number
  fundingZ?: number
  oiChangePctH1?: number
  simSetup?: {
    side: 'LONG' | 'SHORT'
    entry: number
    stop: number
    tp1: number
    tp2: number
    rrr1: number
    risk_usd: number
    size_usd: number
  } | null
}

export default function CandidatesPreview({ list, finalPickerStatus, executionMode }: { list: Candidate[]; finalPickerStatus?: 'idle'|'loading'|'success'|'success_no_picks'|'error'; executionMode?: boolean }) {
  const [showLevels, setShowLevels] = React.useState(true)
  const [exec, setExec] = React.useState<boolean>(() => { try { return (executionMode ?? (localStorage.getItem('execution_mode') === '1')) } catch { return false } })
  React.useEffect(() => {
    const onChange = () => { try { setExec(executionMode ?? (localStorage.getItem('execution_mode') === '1')) } catch {} }
    window.addEventListener('storage', onChange)
    window.addEventListener('app-settings-changed', onChange as any)
    return () => { window.removeEventListener('storage', onChange); window.removeEventListener('app-settings-changed', onChange as any) }
  }, [])
  if (!list?.length) return null
  return (
    <div className="card">
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>Candidate preview (NO-TRADE)</div>
        <label style={{ fontSize: 12, display:'flex', alignItems:'center', gap:6 }}>
          <input type="checkbox" checked={showLevels} onChange={e=>setShowLevels(e.target.checked)} />
          Show trade levels in preview
        </label>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Symbol</th>
            <th>Archetype</th>
            <th>Basket</th>
            <th>Score</th>
            <th>RSI M15</th>
            <th>RSI H1</th>
            <th>ret 24h%</th>
            <th>ret 60m%</th>
            <th>ret 15m%</th>
            <th>VWAP rel</th>
            <th>H1 pos%</th>
            <th>Funding Z</th>
            <th>OI∆% H1</th>
            <th style={{ textAlign: 'left', minWidth: '200px' }}>Reason</th>
            {showLevels && (<>
              <th>Side</th>
              <th>Entry</th>
              <th>SL</th>
              <th>TP1</th>
              <th>TP2</th>
              <th>RRR</th>
            </>)}
          </tr>
        </thead>
        <tbody>
          {list.map((c: any) => {
            // Archetype badge colors
            const archetypeColors: Record<string, string> = {
              'loser_cont': '#dc2626',
              'loser_fade': '#ea580c', 
              'overbought_blowoff': '#7c3aed',
              'mixed': '#6b7280'
            }
            const basketColors: Record<string, string> = {
              'Prime': '#059669',
              'Strong Watch': '#0284c7',
              'Speculative': '#ca8a04'
            }
            return (
              <tr key={c.symbol}>
                <td style={{ fontWeight: 600 }}>{c.symbol}</td>
                <td>
                  <span style={{ 
                    padding: '2px 6px', 
                    borderRadius: '4px', 
                    backgroundColor: archetypeColors[c.archetype || 'mixed'] || '#6b7280',
                    color: 'white',
                    fontSize: '10px',
                    fontWeight: 600
                  }}>
                    {c.archetype === 'loser_cont' ? 'CONT' : 
                     c.archetype === 'loser_fade' ? 'FADE' : 
                     c.archetype === 'overbought_blowoff' ? 'OB' : 
                     'MIX'}
                  </span>
                </td>
                <td>
                  <span style={{ 
                    padding: '2px 6px', 
                    borderRadius: '4px', 
                    backgroundColor: basketColors[c.basket || 'Speculative'] || '#ca8a04',
                    color: 'white',
                    fontSize: '10px',
                    fontWeight: 600
                  }}>
                    {c.basket === 'Prime' ? 'P' : 
                     c.basket === 'Strong Watch' ? 'SW' : 
                     'SP'}
                  </span>
                </td>
                <td style={{ fontWeight: 600, color: c.score >= 0.62 ? '#059669' : c.score >= 0.52 ? '#0284c7' : '#ca8a04' }}>
                  {c.score?.toFixed ? c.score.toFixed(3) : c.score}
                </td>
                <td>{c.rsiM15 != null ? Number(c.rsiM15).toFixed(0) : '—'}</td>
                <td>{c.rsiH1 != null ? Number(c.rsiH1).toFixed(0) : '—'}</td>
                <td style={{ color: (c.ret24hPct || 0) < 0 ? '#dc2626' : '#059669' }}>
                  {c.ret24hPct != null ? Number(c.ret24hPct).toFixed(2) : '—'}
                </td>
                <td style={{ color: (c.ret60mPct || 0) < 0 ? '#dc2626' : '#059669' }}>
                  {c.ret60mPct != null ? Number(c.ret60mPct).toFixed(2) : '—'}
                </td>
                <td style={{ color: (c.ret15mPct || 0) < 0 ? '#dc2626' : '#059669' }}>
                  {c.ret15mPct != null ? Number(c.ret15mPct).toFixed(2) : '—'}
                </td>
                <td>{c.vwapRelM15 != null ? Number(c.vwapRelM15).toFixed(3) : '—'}</td>
                <td>{c.posInH1RangePct != null ? Number(c.posInH1RangePct).toFixed(1) : '—'}</td>
                <td>{c.fundingZ != null ? Number(c.fundingZ).toFixed(2) : '—'}</td>
                <td style={{ color: (c.oiChangePctH1 || 0) > 0 ? '#059669' : '#dc2626' }}>
                  {c.oiChangePctH1 != null ? Number(c.oiChangePctH1).toFixed(2) : '—'}
                </td>
                <td style={{ textAlign: 'left', fontSize: '11px', fontStyle: 'italic' }}>
                  {c.reason || '—'}
                </td>
                {showLevels && (
                  <>
                    <td>{c.simSetup?.side ?? '—'}</td>
                    <td>{c.simSetup ? (c.simSetup.entry.toFixed(3)) : '—'}</td>
                    <td>{c.simSetup ? (c.simSetup.stop.toFixed(3)) : '—'}</td>
                    <td>{c.simSetup ? (c.simSetup.tp1.toFixed(3)) : '—'}</td>
                    <td>{c.simSetup ? (c.simSetup.tp2.toFixed(3)) : '—'}</td>
                    <td>{c.simSetup ? (Number(c.simSetup.rrr1).toFixed(2)) : '—'}</td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="row gap-8 mt-8">
        <button className="btn" onClick={() => { try { writeClipboard(JSON.stringify(list, null, 2)) } catch { console.info('Clipboard skipped: document not focused') } }}>Copy candidates JSON</button>
        {(!exec || finalPickerStatus !== 'success') && (
          <span style={{ fontSize:12, color:'#92400e' }}>Execution mode is OFF — preview only</span>
        )}
      </div>
    </div>
  )
}


