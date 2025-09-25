import React from 'react'

export type HotPick = {
  symbol: string
  rating: string
  confidence: string
  reasoning: string
}

export type HotScreenerProps = {
  hotPicks: HotPick[]
  status: 'idle' | 'loading' | 'success' | 'error'
  onSelectionChange: (selectedSymbols: string[]) => void
  selectedSymbols: string[]
  onAnalyzeSelected: () => void
  blockedSymbols?: string[]
  failedSymbols?: string[]
  onRetryFailed?: () => void
}

export function HotScreener({ hotPicks, status, onSelectionChange, selectedSymbols, onAnalyzeSelected, blockedSymbols = [], failedSymbols = [], onRetryFailed }: HotScreenerProps) {
  const [executing, setExecuting] = React.useState(false)
  const [autoAnalyze, setAutoAnalyze] = React.useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('auto_analyze')
      // Default ON when not set
      return raw == null ? true : raw === '1'
    } catch { return true }
  })
  React.useEffect(() => { try { localStorage.setItem('auto_analyze', autoAnalyze ? '1' : '0') } catch {} }, [autoAnalyze])
  React.useEffect(() => {
    if (status === 'loading') setExecuting(true)
    if (status === 'success' || status === 'error') setExecuting(false)
  }, [status])
  const [retryBusy, setRetryBusy] = React.useState(false)
  const handleToggle = (symbol: string) => {
    const newSelection = selectedSymbols.includes(symbol)
      ? selectedSymbols.filter(s => s !== symbol)
      : [...selectedSymbols, symbol]
    onSelectionChange(newSelection)
  }

  const handleSelectAll = () => {
    onSelectionChange(hotPicks.map(p => p.symbol))
  }

  const handleSelectNone = () => {
    onSelectionChange([])
  }

  if (status === 'idle') {
    return null
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontWeight: 600 }}>
          🔥 Hot Screener Results
          {status === 'loading' && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>Loading...</span>}
          {status === 'error' && <span style={{ marginLeft: 8, fontSize: 12, color: 'crimson' }}>Error</span>}
        </div>
        {status === 'success' && hotPicks.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={handleSelectAll} style={{ fontSize: 12, padding: '4px 8px' }}>
              All
            </button>
            <button className="btn" onClick={handleSelectNone} style={{ fontSize: 12, padding: '4px 8px' }}>
              None
            </button>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {selectedSymbols.length} / {hotPicks.length} selected
            </span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={autoAnalyze} onChange={e=>setAutoAnalyze(e.target.checked)} />
              Auto Analyze
            </label>
            {!!failedSymbols.length && (
              <button
                className="btn"
                onClick={async()=>{ if (!onRetryFailed || retryBusy) return; setRetryBusy(true); try { await onRetryFailed() } finally { setRetryBusy(false) } }}
                disabled={retryBusy}
                style={{ fontSize: 12, padding: '4px 8px', border: '2px solid #333' }}
                title={retryBusy ? 'Working…' : 'Re-run analysis for failed symbols'}
              >
                {retryBusy ? 'Retrying…' : `Retry failed (${failedSymbols.length})`}
              </button>
            )}
          </div>
        )}
      </div>

      {status === 'loading' && (
        <div style={{ padding: 20, textAlign: 'center', opacity: 0.7 }}>
          🤖 GPT-5 analyzuje 50 coinů...
        </div>
      )}

      {status === 'error' && (
        <div style={{ padding: 20, textAlign: 'center', color: 'crimson' }}>
          ❌ Chyba při analýze. Zkuste znovu.
        </div>
      )}

      {status === 'success' && hotPicks.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', opacity: 0.7 }}>
          🤷‍♂️ Žádné hot picks nenalezeny
        </div>
      )}

      {status === 'success' && hotPicks.length > 0 && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {hotPicks.map((pick, index) => (
              <div 
                key={pick.symbol}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: 12,
                  background: selectedSymbols.includes(pick.symbol) ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
                  borderColor: selectedSymbols.includes(pick.symbol) ? '#22c55e' : 'var(--border)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onClick={() => handleToggle(pick.symbol)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input 
                      type="checkbox" 
                      checked={selectedSymbols.includes(pick.symbol)}
                      onChange={() => handleToggle(pick.symbol)}
                      style={{ cursor: 'pointer' }}
                      title={blockedSymbols.includes(pick.symbol) ? 'Blocked by open position/order' : undefined}
                    />
                    <span style={{ fontWeight: 600, fontSize: 14 }}>
                      #{index + 1} {pick.symbol}
                    </span>
                    <span style={{ fontSize: 12 }}>
                      {pick.rating}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 4 }}>
                  <strong>Confidence:</strong> {pick.confidence}
                </div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  <strong>Reasoning:</strong> {pick.reasoning}
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              Vyberte coiny pro detailní analýzu entry/exit bodů
            </div>
            <AnalyzeButton 
              count={selectedSymbols.length} 
              onClick={onAnalyzeSelected} 
              auto={autoAnalyze} 
              selectionKey={[...selectedSymbols].sort().join(',')}
            />
          </div>
        </>
      )}
    </div>
  )
}

function AnalyzeButton({ count, onClick, auto, selectionKey }: { count: number; onClick: () => void; auto?: boolean; selectionKey: string }) {
  const [busy, setBusy] = React.useState(false)
  const canRun = count > 0 && !busy
  const handle = async () => {
    if (!canRun) return
    setBusy(true)
    try { await onClick() } finally { setBusy(false) }
  }
  const lastKeyRef = React.useRef<string>('')
  React.useEffect(() => {
    if (auto && canRun && selectionKey && selectionKey !== lastKeyRef.current) {
      lastKeyRef.current = selectionKey
      handle()
    }
  }, [auto, canRun, selectionKey])
  return (
    <button
      className="btn"
      onClick={handle}
      disabled={!canRun}
      style={{
        background: canRun ? '#22c55e' : undefined,
        color: canRun ? 'white' : undefined,
        position: 'relative',
        minWidth: 180
      }}
      title={canRun ? 'Analyze selected coins' : (count === 0 ? 'Select at least one coin' : 'Working...')}
    >
      {busy ? 'Analyzing…' : `🔍 Analyze Selected (${count})`}
    </button>
  )
}


