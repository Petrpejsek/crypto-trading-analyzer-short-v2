import React from 'react'
type Candidate = {
  symbol: string
  tier: 'SCOUT' | 'WATCH' | 'ALERT' | 'HOT'
  score: number
  atrPctH1: number
  emaOrderH1: string
  rsiM15?: number
  liquidityUsd: number
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
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Symbol</th>
            <th>S</th>
            <th>Tier</th>
            <th>Score</th>
            <th>ATR% H1</th>
            <th>EMA order H1</th>
            <th>RSI M15</th>
            <th>Liquidity (USD)</th>
            <th>ret M15%</th>
            <th>rVol H1</th>
            <th>ret H1%</th>
            <th>vwap rel M15</th>
            <th>oi∆% H1</th>
            <th>fund z</th>
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
          {list.map((c: any) => (
            <tr key={c.symbol}>
              <td>{c.symbol}</td>
              <td>{c.score?.toFixed ? c.score.toFixed(3) : c.score}</td>
              <td>{c.tier}</td>
              <td>{c.score}</td>
              <td>{c.atrPctH1.toFixed(2)}</td>
              <td>{c.emaOrderH1}</td>
              <td>{c.rsiM15 ?? '—'}</td>
              <td>{Math.round(c.liquidityUsd).toLocaleString()}</td>
              <td>{c.ret_m15_pct != null ? Number(c.ret_m15_pct).toFixed(2) : '—'}</td>
              <td>{c.rvol_h1 != null ? Number(c.rvol_h1).toFixed(2) : '—'}</td>
              <td>{c.ret_h1_pct != null ? Number(c.ret_h1_pct).toFixed(2) : '—'}</td>
              <td>{c.vwap_rel_m15 != null ? Number(c.vwap_rel_m15).toFixed(3) : '—'}</td>
              <td>{c.oi_change_pct_h1 != null ? Number(c.oi_change_pct_h1).toFixed(2) : '—'}</td>
              <td>{c.funding_z != null ? Number(c.funding_z).toFixed(2) : '—'}</td>
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
          ))}
        </tbody>
      </table>
      <div className="row gap-8 mt-8">
        <button className="btn" onClick={() => navigator.clipboard.writeText(JSON.stringify(list, null, 2))}>Copy candidates JSON</button>
        {(!exec || finalPickerStatus !== 'success') && (
          <span style={{ fontSize:12, color:'#92400e' }}>Execution mode is OFF — preview only</span>
        )}
      </div>
    </div>
  )
}


