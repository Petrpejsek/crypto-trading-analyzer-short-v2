import React from 'react'
import type { MarketRawSnapshot } from '../../../types/market_raw'

type Props = {
  open: boolean
  onClose: () => void
  lastSnapshot: MarketRawSnapshot | null
  lastRunAt: string | null
}

type Cfg = {
  topN?: number
  candles?: number
  concurrency?: number
  depthMode?: string
  fundingMode?: string
  openInterestMode?: string
}

function readConfigFromSnapshot(s: MarketRawSnapshot | null): Cfg {
  try {
    const anyS = s as any
    const meta = anyS?.meta || anyS?.config || null
    if (!meta || typeof meta !== 'object') return {}
    return {
      topN: Number(meta.topN) || undefined,
      candles: Number(meta.candles) || undefined,
      concurrency: Number(meta.concurrency) || undefined,
      depthMode: typeof meta.depthMode === 'string' ? meta.depthMode : undefined,
      fundingMode: typeof meta.fundingMode === 'string' ? meta.fundingMode : undefined,
      openInterestMode: typeof meta.openInterestMode === 'string' ? meta.openInterestMode : undefined,
    }
  } catch { return {} }
}

export const SettingsDrawer: React.FC<Props & { finalPickerStatus?: 'idle'|'loading'|'success'|'success_no_picks'|'error'; finalPicksCount?: number; posture?: 'OK'|'CAUTION'|'NO-TRADE' }> = ({ open, onClose, lastSnapshot, lastRunAt, finalPickerStatus, finalPicksCount, posture }) => {
  const cfg = readConfigFromSnapshot(lastSnapshot)
  const Item = ({ label, value }: { label: string; value: string | number | undefined }) => (
    <div className="space-between" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ color: 'var(--muted)' }}>{label}</div>
      <div>{value ?? 'n/a'}</div>
    </div>
  )
  const [sidePolicy, setSidePolicy] = React.useState<'long_only' | 'short_only' | 'both'>(() => {
    try { return (localStorage.getItem('side_policy') as any) || 'long_only' } catch { return 'long_only' }
  })
  const [maxPicks, setMaxPicks] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('max_picks')) || 6 } catch { return 6 }
  })
  const [preset, setPreset] = React.useState<'Momentum' | 'Conservative'>(() => {
    try { return (localStorage.getItem('preset') as any) || 'Momentum' } catch { return 'Momentum' }
  })
  const [executionMode, setExecutionMode] = React.useState<boolean>(() => {
    try { return localStorage.getItem('execution_mode') === '1' } catch { return false }
  })
  const [goNowEnabled, setGoNowEnabled] = React.useState<boolean>(() => { try { return (localStorage.getItem('go_now_enabled') ?? '1') === '1' } catch { return true } })
  const [confGoNow, setConfGoNow] = React.useState<number>(() => { try { const v = Number(localStorage.getItem('confidence_go_now_threshold') ?? localStorage.getItem('go_now_conf_threshold')); return Number.isFinite(v) ? v : 0.6 } catch { return 0.6 } })
  const [equity, setEquity] = React.useState<number>(() => { try { return Number(localStorage.getItem('equity_usdt')) || 10000 } catch { return 10000 } })
  const [overrideNoTrade, setOverrideNoTrade] = React.useState<boolean>(() => { try { return (localStorage.getItem('override_no_trade_execution') ?? '0') === '1' } catch { return false } })
  const [overrideNoTradeRisk, setOverrideNoTradeRisk] = React.useState<number>(() => { try { const v = Number(localStorage.getItem('override_no_trade_risk_pct')); return Number.isFinite(v) ? v : 0.10 } catch { return 0.10 } })
  const [noTradeConfFloor, setNoTradeConfFloor] = React.useState<number>(() => { try { const v = Number(localStorage.getItem('no_trade_confidence_floor')); return Number.isFinite(v) ? v : 0.65 } catch { return 0.65 } })
  const [maxLeverage, setMaxLeverage] = React.useState<number>(() => { try { const v = Number(localStorage.getItem('max_leverage')); return Number.isFinite(v) ? v : 20 } catch { return 20 } })
  // Hot trading settings
  const [conservativeBuffer, setConservativeBuffer] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('conservative_entry_buffer')) || 0.1 } catch { return 0.1 }
  })
  const [aggressiveBuffer, setAggressiveBuffer] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('aggressive_entry_buffer')) || 0.3 } catch { return 0.3 }
  })
  const [maxPerCoin, setMaxPerCoin] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('max_per_coin_usdt')) || 500 } catch { return 500 }
  })
  const [maxCoins, setMaxCoins] = React.useState<number>(() => {
    try { return Number(localStorage.getItem('max_coins_count')) || 5 } catch { return 5 }
  })
  const [defaultStrategy, setDefaultStrategy] = React.useState<'conservative' | 'aggressive'>(() => {
    try { return (localStorage.getItem('default_hot_strategy') as any) || 'conservative' } catch { return 'conservative' }
  })
  const [defaultTPLevel, setDefaultTPLevel] = React.useState<'tp1' | 'tp2' | 'tp3'>(() => {
    try { return (localStorage.getItem('default_tp_level') as any) || 'tp2' } catch { return 'tp2' }
  })
  const [confirmReset, setConfirmReset] = React.useState(false)

  const persist = () => {
    try {
      localStorage.setItem('side_policy', sidePolicy)
      localStorage.setItem('max_picks', String(Math.max(1, Math.min(6, maxPicks || 6))))
      localStorage.setItem('preset', preset)
      localStorage.setItem('execution_mode', executionMode ? '1' : '0')
      localStorage.setItem('go_now_enabled', goNowEnabled ? '1' : '0')
      localStorage.setItem('confidence_go_now_threshold', String(confGoNow))
      localStorage.setItem('go_now_conf_threshold', String(confGoNow))
      localStorage.setItem('equity_usdt', String(Math.max(100, equity || 10000)))
      localStorage.setItem('override_no_trade_execution', overrideNoTrade ? '1' : '0')
      localStorage.setItem('override_no_trade_risk_pct', String(Math.max(0, Math.min(1, overrideNoTradeRisk))))
      localStorage.setItem('no_trade_confidence_floor', String(Math.max(0.5, Math.min(0.9, noTradeConfFloor))))
      localStorage.setItem('max_leverage', String(Math.max(1, Math.min(125, Math.round(maxLeverage)))))
      // Hot trading settings
      localStorage.setItem('conservative_entry_buffer', String(Math.max(0, Math.min(10, conservativeBuffer))))
      localStorage.setItem('aggressive_entry_buffer', String(Math.max(0, Math.min(10, aggressiveBuffer))))
      localStorage.setItem('max_per_coin_usdt', String(Math.max(10, maxPerCoin)))
      localStorage.setItem('max_coins_count', String(Math.max(1, Math.min(20, maxCoins))))
      localStorage.setItem('default_hot_strategy', defaultStrategy)
      localStorage.setItem('default_tp_level', defaultTPLevel)
      window.dispatchEvent(new Event('app-settings-changed'))
    } catch {}
  }

  const onResetDefaults = () => {
    try {
      localStorage.setItem('execution_mode', '0')
      localStorage.setItem('side_policy', 'long_only')
      localStorage.setItem('max_picks', '6')
      localStorage.setItem('preset', 'Momentum')
      localStorage.setItem('equity_usdt', '10000')
      localStorage.setItem('confidence_go_now_threshold', '0.6')
      localStorage.setItem('go_now_conf_threshold', '0.6')
      localStorage.setItem('override_no_trade_execution', '0')
      localStorage.setItem('override_no_trade_risk_pct', '0.10')
      localStorage.setItem('no_trade_confidence_floor', '0.65')
      localStorage.setItem('max_leverage', '20')
      localStorage.setItem('go_now_enabled', '1')
      // Hot trading defaults
      localStorage.setItem('conservative_entry_buffer', '0.1')
      localStorage.setItem('aggressive_entry_buffer', '0.3')
      localStorage.setItem('max_per_coin_usdt', '500')
      localStorage.setItem('max_coins_count', '5')
      localStorage.setItem('default_hot_strategy', 'conservative')
      localStorage.setItem('default_tp_level', 'tp2')
      window.dispatchEvent(new Event('app-settings-changed'))
      setConfirmReset(false)
    } catch {}
  }

  return (
    <>
      <div className={open ? 'backdrop open' : 'backdrop'} onClick={onClose} />
      <aside className={open ? 'drawer open' : 'drawer'} aria-hidden={!open} aria-label="Settings">
        <div className="space-between">
          <h3 style={{ margin: 0 }}>Settings</h3>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <div className="mt-12">
          <h4 style={{ margin: '8px 0' }}>Run config</h4>
          <Item label="topN" value={cfg.topN} />
          <Item label="candles" value={cfg.candles} />
          <Item label="concurrency" value={cfg.concurrency} />
          <Item label="depthMode" value={cfg.depthMode} />
          <Item label="fundingMode" value={cfg.fundingMode} />
          <Item label="openInterestMode" value={cfg.openInterestMode} />
        </div>
        <div className="mt-12">
          <h4 style={{ margin: '8px 0' }}>Trade settings</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12 }}>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12, opacity: (finalPickerStatus==='success' && (finalPicksCount??0)>0 && posture!=='NO-TRADE') ? 1 : .6 }} title={(finalPickerStatus==='success' && (finalPicksCount??0)>0 && posture!=='NO-TRADE') ? '' : 'Execution disabled until Final Picker success with picks and not NO-TRADE'}>
              <span style={{ color:'var(--muted)' }}>Execution mode</span>
              <input type="checkbox" checked={executionMode} disabled={!(finalPickerStatus==='success' && (finalPicksCount??0)>0 && posture!=='NO-TRADE')} onChange={e=>setExecutionMode(e.target.checked)} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Side policy</span>
              <select value={sidePolicy} onChange={e=>setSidePolicy(e.target.value as any)}>
                <option value="long_only">LONG only</option>
                <option value="both">LONG/SHORT</option>
                <option value="short_only">SHORT only</option>
              </select>
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Max picks</span>
              <input type="number" min={1} max={6} value={maxPicks} onChange={e=>setMaxPicks(Number(e.target.value))} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Preset</span>
              <select value={preset} onChange={e=>setPreset(e.target.value as any)}>
                <option value="Momentum">Momentum</option>
                <option value="Conservative">Conservative (narrower ATR%)</option>
              </select>
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Go NOW enabled</span>
              <input type="checkbox" checked={goNowEnabled} onChange={e=>setGoNowEnabled(e.target.checked)} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Go NOW min confidence</span>
              <input type="number" step={0.01} min={0.5} max={0.9} value={confGoNow} onChange={e=>setConfGoNow(Number(e.target.value))} />
            </label>
          </div>
          <h4 className="mt-12" style={{ margin: '8px 0' }}>NO-TRADE override</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12, opacity: posture==='NO-TRADE' ? 1 : .6 }}>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }} title={posture==='NO-TRADE' ? '' : 'Dostupné jen v NO-TRADE'}>
              <span style={{ color:'var(--muted)' }}>Override execution in NO-TRADE</span>
              <input type="checkbox" checked={overrideNoTrade} disabled={posture!=='NO-TRADE'} onChange={e=>setOverrideNoTrade(e.target.checked)} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }} title={posture==='NO-TRADE' ? '' : 'Dostupné jen v NO-TRADE'}>
              <span style={{ color:'var(--muted)' }}>Override risk % (of equity)</span>
              <input type="number" min={0} max={1} step={0.01} value={overrideNoTradeRisk} disabled={posture!=='NO-TRADE'} title={posture==='NO-TRADE' ? 'Doporučeno ≤ 0.5 %. Nad 0.5 % se v potvrzení objeví soft-warning. (Neovlivňuje disable logiku.)' : undefined} onChange={e=>setOverrideNoTradeRisk(Number(e.target.value))} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }} title={posture==='NO-TRADE' ? '' : 'Dostupné jen v NO-TRADE'}>
              <span style={{ color:'var(--muted)' }}>Confidence floor</span>
              <input type="number" min={0.5} max={0.9} step={0.01} value={noTradeConfFloor} disabled={posture!=='NO-TRADE'} onChange={e=>setNoTradeConfFloor(Number(e.target.value))} />
            </label>
          </div>
          <h4 className="mt-12" style={{ margin: '8px 0' }}>Risk & leverage</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12 }}>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>max_leverage</span>
              <input type="number" min={1} max={125} step={1} value={maxLeverage} onChange={e=>setMaxLeverage(Number(e.target.value))} />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>equity_usdt</span>
              <input type="number" min={100} step={100} value={equity} onChange={e=>setEquity(Number(e.target.value))} />
            </label>
          </div>
          <h4 className="mt-12" style={{ margin: '8px 0' }}>Hot Trading Settings</h4>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 12 }}>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Conservative buffer %</span>
              <input 
                type="number" 
                min={0} 
                max={5} 
                step={0.1} 
                value={conservativeBuffer} 
                onChange={e=>setConservativeBuffer(Number(e.target.value))}
                title="Procento nad minimum entry pro konzervativní strategii"
              />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Aggressive buffer %</span>
              <input 
                type="number" 
                min={0} 
                max={5} 
                step={0.1} 
                value={aggressiveBuffer} 
                onChange={e=>setAggressiveBuffer(Number(e.target.value))}
                title="Procento nad minimum entry pro agresivní strategii"
              />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Max per coin ($)</span>
              <input 
                type="number" 
                min={10} 
                step={10} 
                value={maxPerCoin} 
                onChange={e=>setMaxPerCoin(Number(e.target.value))}
                title="Maximální částka na jeden coin"
              />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Max coins count</span>
              <input 
                type="number" 
                min={1} 
                max={20} 
                step={1} 
                value={maxCoins} 
                onChange={e=>setMaxCoins(Number(e.target.value))}
                title="Maximální počet coinů současně"
              />
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Default strategy</span>
              <select value={defaultStrategy} onChange={e=>setDefaultStrategy(e.target.value as any)}>
                <option value="conservative">Conservative</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </label>
            <label style={{ display:'flex', flexDirection:'column', gap:6, fontSize:12 }}>
              <span style={{ color:'var(--muted)' }}>Default TP level</span>
              <select value={defaultTPLevel} onChange={e=>setDefaultTPLevel(e.target.value as any)}>
                <option value="tp1">TP1</option>
                <option value="tp2">TP2</option>
                <option value="tp3">TP3</option>
              </select>
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            Total max exposure: ${(maxPerCoin * maxCoins).toLocaleString()}
          </div>
          <div className="row gap-8" style={{ marginTop: 12 }}>
            <button className="btn" onClick={persist}>Save</button>
            <button className="btn" onClick={()=>{ setSidePolicy('long_only'); setMaxPicks(6); setPreset('Momentum'); setExecutionMode(false); setGoNowEnabled(true); setConfGoNow(0.6); setOverrideNoTrade(false); setOverrideNoTradeRisk(0.10); setNoTradeConfFloor(0.65); setMaxLeverage(20); setEquity(10000); setConservativeBuffer(0.1); setAggressiveBuffer(0.3); setMaxPerCoin(500); setMaxCoins(5); setDefaultStrategy('conservative'); setDefaultTPLevel('tp2'); setTimeout(persist, 0) }}>Reset defaults (local)</button>
            <button className="btn" onClick={()=>setConfirmReset(true)}>Reset to defaults</button>
          </div>
        </div>
        <div className="mt-12">
          <h4 style={{ margin: '8px 0' }}>Build info</h4>
          <Item label="Last run" value={lastRunAt ?? 'n/a'} />
          <Item label="Snapshot timestamp" value={lastSnapshot?.timestamp ?? 'n/a'} />
          <Item label="Symbols" value={lastSnapshot?.universe ? 2 + lastSnapshot.universe.length : 'n/a'} />
        </div>
      </aside>
      {confirmReset ? (
        <div role="dialog" aria-modal="true" className="modal" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="card" style={{ minWidth: 300, background:'#fff', padding: 16, borderRadius: 8 }}>
            <div className="space-between" style={{ marginBottom: 8 }}>
              <strong>Reset settings?</strong>
              <button className="btn" onClick={()=>setConfirmReset(false)}>Close</button>
            </div>
            <div style={{ fontSize: 14 }}>This will restore all settings to defaults.</div>
            <div className="row gap-8" style={{ marginTop: 12, justifyContent:'flex-end' }}>
              <button className="btn" onClick={()=>setConfirmReset(false)}>No</button>
              <button className="btn" onClick={onResetDefaults}>Yes</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}


