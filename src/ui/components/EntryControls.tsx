import React from 'react'

export type StrategyPlan = {
  entry: string
  sl: string
  tp1: string
  tp2: string
  tp3: string
  risk: string
  reasoning: string
}

export type EntryStrategyData = {
  symbol: string
  conservative: StrategyPlan
  aggressive: StrategyPlan
}

export type CoinControl = {
  symbol: string
  include: boolean
  side?: 'LONG' | 'SHORT'
  strategy: 'conservative' | 'aggressive'
  tpLevel: 'tp1' | 'tp2' | 'tp3'
  orderType?: 'market' | 'limit' | 'stop' | 'stop_limit'
  amount: number
  leverage: number
  customBuffer?: number
  useCustomBuffer: boolean
}

export type EntryControlsProps = {
  entryStrategies: EntryStrategyData[]
  coinControls: CoinControl[]
  onControlChange: (symbol: string, updates: Partial<CoinControl>) => void
  status: 'idle' | 'loading' | 'success' | 'error'
  currentPrices?: Record<string, number>
  globalBuffers: { conservative: number; aggressive: number }
  maxPerCoin: number
  maxCoins: number
  onPrepareOrders: () => void
  placing?: boolean
}

export function EntryControls({ 
  entryStrategies, 
  coinControls, 
  onControlChange, 
  status,
  currentPrices,
  globalBuffers,
  maxPerCoin,
  maxCoins,
  onPrepareOrders,
  placing
}: EntryControlsProps) {
  const [autoPrepare, setAutoPrepare] = React.useState<boolean>(() => {
    try { return localStorage.getItem('auto_prepare') === '1' } catch { return false }
  })
  React.useEffect(() => { try { localStorage.setItem('auto_prepare', autoPrepare ? '1' : '0') } catch {} }, [autoPrepare])
  const selectionKey = React.useMemo(() => {
    try { return coinControls.filter(c=>c.include).map(c=>c.symbol).sort().join(',') } catch { return '' }
  }, [coinControls])
  const handleControlUpdate = (symbol: string, field: keyof CoinControl, value: any) => {
    if (field === 'strategy') {
      const defaultType = (value as any) === 'conservative' ? 'limit' : 'stop_limit'
      onControlChange(symbol, { [field]: value, orderType: defaultType })
      return
    }
    onControlChange(symbol, { [field]: value })
  }

  const renderKeyRow = (plan: StrategyPlan) => {
    const wrap: React.CSSProperties = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 8,
      alignItems: 'stretch',
      marginBottom: 8
    }
    const boxBase: React.CSSProperties = {
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '6px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      lineHeight: 1.15,
      fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif'
    }
    const label: React.CSSProperties = { fontSize: 11, opacity: 0.7 }
    const valueNum: React.CSSProperties = { fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' as any }
    const valueText: React.CSSProperties = { fontSize: 14, fontWeight: 700, lineHeight: 1.2 as any, whiteSpace: 'pre-wrap' as any, display: '-webkit-box', WebkitLineClamp: 3 as any, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' }
    const box = (lbl: string, val: string, color: string, bg: string, isText = false) => (
      <div style={{ ...boxBase, borderColor: color, background: bg }}>
        <span style={label}>{lbl}</span>
        <span style={isText ? valueText : valueNum}>{val}</span>
      </div>
    )
    return (
      <div style={{ ...wrap, gridAutoRows: '1fr' }}>
        {box('Entry', plan.entry, '#3b82f6', 'rgba(59,130,246,0.08)', true)}
        {box('SL', plan.sl, '#ef4444', 'rgba(239,68,68,0.08)')}
        {box('TP1', plan.tp1, '#22c55e', 'rgba(34,197,94,0.08)')}
        {box('TP2', plan.tp2, '#16a34a', 'rgba(22,163,74,0.08)')}
        {box('TP3', plan.tp3, '#15803d', 'rgba(21,128,61,0.08)')}
      </div>
    )
  }

  const includedCount = coinControls.filter(c => c.include).length
  const totalAmount = coinControls.filter(c => c.include).reduce((sum, c) => sum + c.amount, 0)

  if (status === 'idle') {
    return null
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 600 }}>
          📊 Řízení vstupů (Entry)
          {status === 'loading' && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>Analyzuji…</span>}
          {status === 'error' && <span style={{ marginLeft: 8, fontSize: 12, color: 'crimson' }}>Chyba</span>}
        </div>
        {status === 'success' && (
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {includedCount} / {maxCoins} coinů • ${totalAmount.toLocaleString()} celkem
          </div>
        )}
      </div>

      {status === 'loading' && (
        <div style={{ padding: 20, textAlign: 'center', opacity: 0.7 }}>
          🤖 GPT-5 analyzuje vstupy/výstupy…
        </div>
      )}

      {status === 'error' && (
        <div style={{ padding: 20, textAlign: 'center', color: 'crimson' }}>
          ❌ Chyba při analýze strategií. Zkuste znovu.
        </div>
      )}

      {status === 'success' && entryStrategies.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', opacity: 0.7 }}>
          🤷‍♂️ Žádné strategie vstupu nenalezeny
        </div>
      )}

      {status === 'success' && entryStrategies.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {entryStrategies.map((strategy) => {
              const control = coinControls.find(c => c.symbol === strategy.symbol)
              if (!control) return null

              const selectedPlan = control.strategy === 'conservative' ? strategy.conservative : strategy.aggressive
              const now = currentPrices?.[strategy.symbol]
              const bufferValue = control.useCustomBuffer ? control.customBuffer : globalBuffers[control.strategy]

              return (
                <div 
                  key={strategy.symbol}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 16,
                    background: control.include ? 'rgba(34, 197, 94, 0.05)' : 'transparent',
                    borderColor: control.include ? '#22c55e' : 'var(--border)',
                    opacity: control.include ? 1 : 0.7
                  }}
                >
                  {/* Header with symbol and include toggle */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input 
                        type="checkbox" 
                        checked={control.include}
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'include', e.target.checked)}
                      />
                      <span style={{ fontWeight: 600, fontSize: 16 }}>
                        {strategy.symbol}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      Risk: {selectedPlan.risk}
                    </div>
                  </div>

                  {/* Strategy selection and details */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 12, alignItems: 'start', overflow: 'hidden' }}>
                    {Number.isFinite(now as any) && (
                      <div style={{ gridColumn: '1 / -1', fontSize: 12, opacity: 0.8, display: 'flex', gap: 12, alignItems: 'center' }}>
                        <span>Aktuální cena (last): <strong>{(now as number).toFixed(6)}</strong></span>
                        <span style={{ opacity: .85 }}>(MARK validace probíhá na serveru)</span>
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <h5 style={{ margin: '0 0 8px 0', fontSize: 14, color: 'var(--muted)' }}>Conservative</h5>
                      <div style={{ 
                        padding: 12, 
                        border: control.strategy === 'conservative' ? '2px solid #22c55e' : '1px solid var(--border)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: control.strategy === 'conservative' ? 'rgba(34, 197, 94, 0.08)' : 'transparent'
                      }} onClick={() => handleControlUpdate(strategy.symbol, 'strategy', 'conservative')}>
                        {renderKeyRow(strategy.conservative)}
                        <div style={{ fontSize: 11, opacity: 0.8 }}>
                          {strategy.conservative.reasoning}
                        </div>
                      </div>
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <h5 style={{ margin: '0 0 8px 0', fontSize: 14, color: 'var(--muted)' }}>Aggressive</h5>
                      <div style={{ 
                        padding: 12, 
                        border: control.strategy === 'aggressive' ? '2px solid #f59e0b' : '1px solid var(--border)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: control.strategy === 'aggressive' ? 'rgba(245, 158, 11, 0.08)' : 'transparent'
                      }} onClick={() => handleControlUpdate(strategy.symbol, 'strategy', 'aggressive')}>
                        {renderKeyRow(strategy.aggressive)}
                        <div style={{ fontSize: 11, opacity: 0.8 }}>
                          {strategy.aggressive.reasoning}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Controls grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Typ příkazu</span>
                      <select 
                        value={control.orderType || (control.strategy === 'conservative' ? 'limit' : 'market')}
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'orderType', e.target.value as any)}
                        disabled={!control.include}
                      >
                        <option value="market">Market</option>
                        <option value="limit">Limit</option>
                        <option value="stop">Stop (market)</option>
                        <option value="stop_limit">Stop-Limit</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Side</span>
                      <select 
                        value={control.side || 'LONG'} 
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'side', e.target.value as any)}
                        disabled={!control.include}
                      >
                        <option value="LONG">LONG</option>
                        <option value="SHORT">SHORT</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>TP úroveň</span>
                      <select 
                        value={control.tpLevel} 
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'tpLevel', e.target.value as any)}
                        disabled={!control.include}
                      >
                        <option value="tp1">TP1</option>
                        <option value="tp2">TP2</option>
                        <option value="tp3">TP3</option>
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Částka ($)</span>
                      <input 
                        type="number" 
                        min={10} 
                        max={maxPerCoin}
                        step={10}
                        value={control.amount} 
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'amount', Number(e.target.value))}
                        disabled={!control.include}
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Páka</span>
                      <select 
                        value={control.leverage} 
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'leverage', Number(e.target.value))}
                        disabled={!control.include}
                      >
                        {[1,2,3,5,10,15,20].map(lev => (
                          <option key={lev} value={lev}>{lev}x</option>
                        ))}
                      </select>
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Preset</span>
                      <select 
                        value={control.strategy}
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'strategy', e.target.value as any)}
                        disabled={!control.include}
                      >
                        <option value="conservative">Conservative</option>
                        <option value="aggressive">Aggressive</option>
                      </select>
                    </label>

                    {control.useCustomBuffer && (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                        <span style={{ color: 'var(--muted)' }}>Vlastní %</span>
                        <input 
                          type="number" 
                          min={0} 
                          max={5} 
                          step={0.1}
                          value={control.customBuffer || 0} 
                          onChange={(e) => handleControlUpdate(strategy.symbol, 'customBuffer', Number(e.target.value))}
                          disabled={!control.include}
                        />
                      </label>
                    )}
                  </div>

                  <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
                    Finální buffer vstupu: {bufferValue || 0}% • Cíl: {selectedPlan[control.tpLevel]}
                  </div>
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Max expozice rizika: ${totalAmount.toLocaleString()} / ${(maxPerCoin * maxCoins).toLocaleString()}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={autoPrepare} onChange={e=>setAutoPrepare(e.target.checked)} />
                Auto Prepare
              </label>
              <PrepareButton count={includedCount} placing={placing} onClick={onPrepareOrders} auto={autoPrepare} selectionKey={selectionKey} />
            </div>
          </div>
          {placing ? (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              Odesílám objednávky na burzu…
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function PrepareButton({ count, placing, onClick, auto, selectionKey }: { count: number; placing?: boolean; onClick: () => void; auto?: boolean; selectionKey: string }) {
  const disabled = count === 0 || !!placing
  const handle = async () => { if (!disabled) await onClick() }
  const lastKeyRef = React.useRef<string>('')
  React.useEffect(() => {
    if (auto && !disabled && selectionKey && selectionKey !== lastKeyRef.current) {
      lastKeyRef.current = selectionKey
      handle()
    }
  }, [auto, disabled, selectionKey])
  return (
    <button
      className="btn"
      onClick={handle}
      disabled={disabled}
      style={{ background: !disabled ? '#22c55e' : undefined, color: !disabled ? 'white' : undefined }}
    >
      {placing ? '⏳ Odesílám…' : `🎯 Připravit objednávky (${count})`}
    </button>
  )
}


