import React, { useState, useEffect } from 'react'

/**
 * Widget pro nastavení ENTRY_PRICE_MULTIPLIER
 * Umožňuje upravit entry cenu o zadané procento (např. 100.5% = +0.5%)
 */
const EntryPriceMultiplierWidget: React.FC = () => {
  const [multiplier, setMultiplier] = useState<number>(100.0)
  const [inputValue, setInputValue] = useState<string>('100.0')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const MIN_MULTIPLIER = 95.0
  const MAX_MULTIPLIER = 105.0

  // Načti aktuální hodnotu při mount
  useEffect(() => {
    loadCurrentValue()
  }, [])

  const loadCurrentValue = async () => {
    try {
      const res = await fetch('/api/config/trading')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      
      // STRICT: Pokud není hodnota v configu, je to CHYBA, ne fallback
      if (!data?.ok || !data?.config) {
        throw new Error('Invalid API response structure')
      }
      
      const value = Number(data.config.ENTRY_PRICE_MULTIPLIER)
      if (!Number.isFinite(value)) {
        throw new Error('ENTRY_PRICE_MULTIPLIER not found in config')
      }
      
      setMultiplier(value)
      setInputValue(value.toFixed(1))
      setError(null)
    } catch (e: any) {
      console.error('[MULTIPLIER_LOAD_ERROR]', e)
      setError(`Chyba načtení: ${e.message}`)
      // IMPORTANT: Neměníme state hodnoty při chybě - zobrazíme jen error
    }
  }

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value)
    setMultiplier(value)
    setInputValue(value.toFixed(1))
    setSuccess(false)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value)
    setSuccess(false)
  }

  const handleInputBlur = () => {
    const value = Number(inputValue)
    if (Number.isFinite(value) && value >= MIN_MULTIPLIER && value <= MAX_MULTIPLIER) {
      setMultiplier(value)
    } else {
      setInputValue(multiplier.toFixed(1))
    }
  }

  const handleSave = async () => {
    setError(null)
    setSuccess(false)
    setSaving(true)

    try {
      const res = await fetch('/api/config/trading', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ENTRY_PRICE_MULTIPLIER: multiplier })
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data?.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Neznámá chyba')

      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (e: any) {
      console.error('[MULTIPLIER_SAVE_ERROR]', e)
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const changePercent = ((multiplier - 100.0)).toFixed(2)
  const changeSign = multiplier >= 100.0 ? '+' : ''

  return (
    <div
      style={{
        position: 'fixed',
        top: 220,
        right: 8,
        width: expanded ? 280 : 180,
        background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
        border: '1px solid #334155',
        borderRadius: 8,
        padding: 12,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: 1000,
        transition: 'width 0.2s ease'
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: expanded ? 10 : 0,
          cursor: 'pointer'
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>
          Entry Multiplier
        </div>
        <div style={{ fontSize: 11, color: '#94a3b8' }}>
          {expanded ? '▼' : '▶'}
        </div>
      </div>

      {/* Collapsed view - pouze aktuální hodnota */}
      {!expanded && (
        <div style={{ fontSize: 20, fontWeight: 700, color: multiplier === 100.0 ? '#64748b' : '#3b82f6', marginTop: 4 }}>
          {multiplier.toFixed(1)}%
          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
            ({changeSign}{changePercent}%)
          </span>
        </div>
      )}

      {/* Expanded view - ovládací prvky */}
      {expanded && (
        <>
          {/* Aktuální hodnota */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#94a3b8' }}>Aktuální:</span>
            <div style={{ fontSize: 18, fontWeight: 700, color: multiplier === 100.0 ? '#64748b' : '#3b82f6' }}>
              {multiplier.toFixed(1)}%
              <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 6 }}>
                ({changeSign}{changePercent}%)
              </span>
            </div>
          </div>

          {/* Slider */}
          <div style={{ marginBottom: 10 }}>
            <input
              type="range"
              min={MIN_MULTIPLIER}
              max={MAX_MULTIPLIER}
              step={0.1}
              value={multiplier}
              onChange={handleSliderChange}
              style={{
                width: '100%',
                accentColor: '#3b82f6'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748b', marginTop: 2 }}>
              <span>{MIN_MULTIPLIER}%</span>
              <span>100%</span>
              <span>{MAX_MULTIPLIER}%</span>
            </div>
          </div>

          {/* Number input */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <input
              type="number"
              min={MIN_MULTIPLIER}
              max={MAX_MULTIPLIER}
              step={0.1}
              value={inputValue}
              onChange={handleInputChange}
              onBlur={handleInputBlur}
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 13,
                background: '#0f172a',
                border: '1px solid #334155',
                borderRadius: 4,
                color: '#e2e8f0'
              }}
            />
            <span style={{ fontSize: 11, color: '#94a3b8' }}>%</span>
          </div>

          {/* Příklad výpočtu */}
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, padding: 8, background: '#0f172a', borderRadius: 4 }}>
            <div style={{ marginBottom: 4, color: '#94a3b8' }}>Příklad:</div>
            <div>AI vrátí: 100.00 USDT</div>
            <div>Na burzu: {(100 * (multiplier / 100)).toFixed(2)} USDT</div>
          </div>

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 13,
              fontWeight: 600,
              background: success ? '#10b981' : '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.6 : 1,
              transition: 'all 0.2s ease'
            }}
          >
            {saving ? 'Ukládám...' : success ? '✓ Uloženo' : 'Uložit'}
          </button>

          {/* Error message */}
          {error && (
            <div style={{ marginTop: 8, padding: 6, background: '#991b1b', borderRadius: 4, fontSize: 11, color: '#fecaca' }}>
              {error}
            </div>
          )}

          {/* Info text */}
          <div style={{ marginTop: 10, fontSize: 9, color: '#64748b', lineHeight: 1.4 }}>
            Pro SHORT: vyšší % = vyšší entry cena = lepší vstup (prodáváš dráž). SL a TP zůstávají beze změny.
          </div>
        </>
      )}
    </div>
  )
}

export default EntryPriceMultiplierWidget

