import React from 'react'

export type StrategyPlan = {
  entry: number
  sl: number
  tp1?: number
  tp2?: number
  tp3?: number
  risk?: string
  reasoning?: string
}

export type StrategyPlanOrError = StrategyPlan | { error: string }

export type EntryStrategyData = {
  symbol: string
  risk_profile?: 'conservative' | 'aggressive'
  confidence?: number
  conservative: StrategyPlanOrError
  aggressive: StrategyPlanOrError
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
  failedSymbols?: string[]
  riskDecision?: Record<string, { decision: 'enter'|'skip'; risk_profile: 'conservative'|'aggressive'|null; prob_success: number|null; conservative_score?: number|null; aggressive_score?: number|null; reasons?: string[] }>
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
  placing,
  failedSymbols,
  riskDecision
}: EntryControlsProps) {
  
  // Debug risk decision data
  React.useEffect(() => {
    console.log('[ENTRY_CONTROLS_RISK_DECISION]', { riskDecision })
  }, [riskDecision])
  
  // Persist Auto Prepare across rerenders and runs – no extra logic, only automates existing Prepare button
  const [autoPrepare, setAutoPrepare] = React.useState<boolean>(() => {
    try { return localStorage.getItem('auto_prepare') === '1' } catch { return false }
  })
  React.useEffect(() => {
    try { localStorage.setItem('auto_prepare', autoPrepare ? '1' : '0') } catch {}
  }, [autoPrepare])
  const selectionKey = React.useMemo(() => {
    try { return coinControls.filter(c=>c.include).map(c=>c.symbol).sort().join(',') } catch { return '' }
  }, [coinControls])
  // Auto Prepare fix: zahrň stav Risk Manageru do trigger klíče,
  // aby se Auto Prepare znovu spustil ve chvíli, kdy dorazí GO/NO-GO
  const riskGateKey = React.useMemo(() => {
    try {
      const included = new Set(coinControls.filter(c => c.include).map(c => c.symbol))
      const pairs = Object.entries(riskDecision || {})
        .filter(([sym]) => included.has(sym))
        .map(([sym, r]) => `${sym}:${(r as any)?.decision || 'unknown'}`)
        .sort()
      return pairs.join('|')
    } catch { return '' }
  }, [coinControls, riskDecision])
  const handleControlUpdate = (symbol: string, field: keyof CoinControl, value: any) => {
    if (field === 'strategy') {
      const defaultType = (value as any) === 'conservative' ? 'limit' : 'stop_limit'
      onControlChange(symbol, { [field]: value, orderType: defaultType })
      return
    }
    onControlChange(symbol, { [field]: value })
  }

  const isPlan = (p: StrategyPlanOrError): p is StrategyPlan => {
    return p != null && 
           typeof (p as any).entry === 'number' && 
           typeof (p as any).sl === 'number'
  }

  // Cooldowns for badge
  const [cooldowns, setCooldowns] = React.useState<Record<string, string>>({})
  React.useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const ac = new AbortController()
        const tm = setTimeout(() => ac.abort(), 7000)
        const r = await fetch('/api/cooldowns', { method: 'GET', signal: ac.signal })
        clearTimeout(tm)
        if (!mounted) return
        if (r.ok) {
          const j = await r.json().catch(()=>null)
          const map: Record<string, string> = {}
          const arr = Array.isArray(j?.active) ? j.active : []
          for (const it of arr) {
            try { map[String(it.symbol)] = String(it.until) } catch {}
          }
          setCooldowns(map)
        }
      } catch {}
    }
    load().catch(()=>{})
    const t = setInterval(load, 15000)
    return () => { mounted = false; clearInterval(t) }
  }, [])

  const renderKeyRow = (plan: StrategyPlanOrError) => {
    if (!isPlan(plan)) {
      return (
        <div style={{ padding: 12, border: '1px solid #f87171', borderRadius: 8, background: 'rgba(248,113,113,0.08)', color: '#b91c1c' }}>
          ❌ {plan && (plan as any).error ? String((plan as any).error) : 'Neplatný plán'}
        </div>
      )
    }
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
    const fmt = (n: number | string | undefined) => typeof n === 'number' ? String(n) : '-'
    const box = (lbl: string, val: number | string, color: string, bg: string, isText = false) => (
      <div style={{ ...boxBase, borderColor: color, background: bg }}>
        <span style={label}>{lbl}</span>
        {isText ? (
          <span style={valueText}>{fmt(val)}</span>
        ) : (
          <span style={valueNum}>{fmt(val)}</span>
        )}
      </div>
    )
    return (
      <div style={wrap}>
        {box('Entry', isPlan(plan) ? plan.entry : '-', '#22c55e', 'rgba(34,197,94,0.06)')}
        {box('SL', isPlan(plan) ? plan.sl : '-', '#ef4444', 'rgba(239,68,68,0.06)')}
        {box('TP1', isPlan(plan) ? plan.tp1 : '-', '#eab308', 'rgba(234,179,8,0.06)')}
        {box('TP2', isPlan(plan) ? plan.tp2 : '-', '#eab308', 'rgba(234,179,8,0.06)')}
        {box('TP3', isPlan(plan) ? plan.tp3 : '-', '#eab308', 'rgba(234,179,8,0.06)')}
        {isPlan(plan) && plan.risk ? box('Risk', plan.risk, '#64748b', 'rgba(100,116,139,0.06)', true) : null}
      </div>
    )
  }

  const RiskBadge: React.FC<{ profile: 'conservative' | 'aggressive' | undefined; confidence: number | undefined }> = ({ profile, confidence }) => {
    // Thresholds removed: only display chosen profile and confidence percent
    const prof = (profile === 'aggressive' || profile === 'conservative') ? profile : undefined
    const conf = Number(confidence)
    const pct = Number.isFinite(conf as any) ? Math.round((conf as number) * 100) : null
    const bg = !prof ? '#6b7280' : (prof === 'aggressive' ? '#e11d48' : '#2563eb')
    const label = !prof ? '—' : `${prof === 'aggressive' ? 'Aggressive' : 'Conservative'}${pct != null ? ` ${pct}%` : ''}`
    const title = !prof ? 'No risk profile' : `Selected by model${pct != null ? ` • ${pct}%` : ''}`
    return (
      <span title={title} style={{ padding: '2px 6px', borderRadius: 6, background: bg, color: '#fff', fontSize: 12 }}>{label}</span>
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

      {Array.isArray(failedSymbols) && failedSymbols.length > 0 && (
        <div style={{ marginBottom: 12, padding: 8, border: '1px solid #664', borderRadius: 6, background: 'rgba(255,200,0,0.07)', fontSize: 12 }}>
          Některé coiny nevrátily platný GPT plán a nejsou zahrnuté v Entry: <strong>{failedSymbols.join(', ')}</strong>.
          {(() => {
            try {
              const map = (window as any).__entry_failed_reasons || {}
              const parts = failedSymbols.map(s => {
                const c = map[s]
                return c ? `${s}(${c})` : null
              }).filter(Boolean)
              return parts.length ? (
                <span style={{ marginLeft: 6, opacity: 0.9 }}>Důvod: {parts.join(', ')}</span>
              ) : null
            } catch { return null }
          })()}
          <span style={{ marginLeft: 6, opacity: 0.8 }}>Klikni znovu na Analyze Selected pro opakování.</span>
        </div>
      )}

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
              const prof = (strategy.risk_profile === 'aggressive' || strategy.risk_profile === 'conservative') ? strategy.risk_profile : undefined
              const conf = Number(strategy.confidence)
              const gatePass = isPlan(selectedPlan)
              const now = currentPrices?.[strategy.symbol]
              const bufferValue = control.useCustomBuffer ? control.customBuffer : globalBuffers[control.strategy]
              const coinRisk = riskDecision?.[strategy.symbol]

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
                        checked={control.include && gatePass}
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'include', e.target.checked && gatePass)}
                      />
                      <span style={{ fontWeight: 600, fontSize: 16 }}>
                        {strategy.symbol}
                      </span>
                      <RiskBadge profile={prof} confidence={Number.isFinite(conf as any) ? (conf as number) : undefined} />
                      {coinRisk && (
                        <span
                          title={coinRisk.decision === 'enter' ? 'GO – povoleno objednat' : 'NO-GO – zakázáno objednat'}
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            borderRadius: 999,
                            background: coinRisk.decision === 'enter' ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                            color: coinRisk.decision === 'enter' ? '#16a34a' : '#ef4444',
                            border: `1px solid ${coinRisk.decision === 'enter' ? '#16a34a' : '#ef4444'}`
                          }}
                        >
                          {coinRisk.decision === 'enter' ? 'GO' : 'NO-GO'}
                        </span>
                      )}
                      {cooldowns[strategy.symbol] && (
                        <span title={`Cooldown do ${new Date(cooldowns[strategy.symbol]).toLocaleTimeString()}`} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid #ef4444' }}>COOLDOWN</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      Risk: {isPlan(selectedPlan) && selectedPlan.risk ? selectedPlan.risk : '—'}
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
                        {isPlan(strategy.conservative) && strategy.conservative.reasoning ? (
                          <div style={{ fontSize: 11, opacity: 0.8 }}>
                            {strategy.conservative.reasoning}
                          </div>
                        ) : null}
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
                        {isPlan(strategy.aggressive) && strategy.aggressive.reasoning ? (
                          <div style={{ fontSize: 11, opacity: 0.8 }}>
                            {strategy.aggressive.reasoning}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* Risk Manager banner – umístěn až za Conservative/Aggressive kontejnery */}
                  {(() => {
                    const risk = riskDecision?.[strategy.symbol]
                    if (!risk) return null
                    const isEnter = risk.decision === 'enter'
                    const pct = Number.isFinite(risk.prob_success as any) ? Math.round((risk.prob_success as number) * 100) : null
                    const prof = risk.risk_profile === 'aggressive' ? 'Aggressive' : risk.risk_profile === 'conservative' ? 'Conservative' : '—'
                    const bg = isEnter ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'
                    const border = isEnter ? '#22c55e' : '#ef4444'
                    return (
                      <div style={{ marginTop: 8, padding: 12, border: `1px solid ${border}`, borderRadius: 8, background: bg }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong>{isEnter ? 'GO' : 'NO-GO'}</strong>
                          <span style={{ fontSize: 12, opacity: .9 }}>{prof}{pct != null ? ` • ${pct}%` : ''}</span>
                        </div>
                        {Array.isArray(risk.reasons) && risk.reasons.length > 0 && (
                          <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12 }}>
                            {risk.reasons.slice(0,3).map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )
                  })()}

                  {/* Controls grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Typ příkazu</span>
                      <select 
                        value={control.orderType || (control.strategy === 'conservative' ? 'limit' : 'stop_limit')}
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'orderType', e.target.value as any)}
                        disabled
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
                        disabled
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
                        disabled
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
                        disabled
                      />
                    </label>

                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                      <span style={{ color: 'var(--muted)' }}>Páka</span>
                      <select 
                        value={control.leverage} 
                        onChange={(e) => handleControlUpdate(strategy.symbol, 'leverage', Number(e.target.value))}
                        disabled
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
                        disabled
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
                          onChange={() => {}}
                          disabled
                        />
                      </label>
                    )}
                  </div>

                  <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
                    {isPlan(selectedPlan) ? (
                      <>Finální buffer vstupu: {bufferValue || 0}% • Cíl: {(() => { const v = (selectedPlan as any)[control.tpLevel]; return typeof v === 'number' ? v : '—' })()}</>
                    ) : (
                      <>Finální buffer vstupu: {bufferValue || 0}% • Cíl: —</>
                    )}
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
                <input type="checkbox" checked={autoPrepare} onChange={(e) => setAutoPrepare(e.target.checked)} />
                Auto Prepare
              </label>
              <PrepareButton 
                count={includedCount} 
                placing={placing} 
                onClick={onPrepareOrders} 
                auto={autoPrepare} 
                selectionKey={`${selectionKey}|${riskGateKey}`}
              />
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


