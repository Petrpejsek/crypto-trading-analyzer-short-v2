import React, { useEffect, useMemo, useRef, useState } from 'react'

type Props = {
  running: boolean
  onRun: () => void
  onExportSnapshot: () => void
  onExportFeatures: () => void
  onToggleSettings: () => void
  onToggleReport: () => void
  showingReport?: boolean
  defaultPreset?: 'conservative' | 'aggressive'
  onChangeDefaultPreset?: (p: 'conservative' | 'aggressive') => void
  // New global defaults for hot trading controls
  defaultSide?: 'LONG' | 'SHORT'
  onChangeDefaultSide?: (s: 'LONG' | 'SHORT') => void
  defaultTPLevel?: 'tp1' | 'tp2' | 'tp3'
  onChangeDefaultTPLevel?: (t: 'tp1' | 'tp2' | 'tp3') => void
  defaultAmount?: number
  onChangeDefaultAmount?: (n: number) => void
  defaultLeverage?: number
  onChangeDefaultLeverage?: (n: number) => void
  // RAW copy flow (propagováno z App)
  universeStrategy?: 'volume' | 'gainers'
  onChangeUniverse?: (u: 'volume' | 'gainers') => void
  onCopyRawAll?: () => Promise<void> | void
  rawLoading?: boolean
  rawCopied?: boolean
  count?: number
  // Propagace toggle do App: při změně checkboxu Auto Copy RAW
  onAutoCopyRawToggle?: (enabled: boolean) => void
  // NEW: server-driven countdown from WF nextAt; when present, overrides local countdown display
  serverNextAt?: string | null
  // NEW: toggle AI Payloads panel
  onToggleAiPayloads?: () => void
}

export const HeaderBar: React.FC<Props> = ({ running, onRun, onExportSnapshot, onExportFeatures, onToggleSettings, onToggleReport, showingReport, defaultPreset='conservative', onChangeDefaultPreset, defaultSide='LONG', onChangeDefaultSide, defaultTPLevel='tp2', onChangeDefaultTPLevel, defaultAmount=20, onChangeDefaultAmount, defaultLeverage=15, onChangeDefaultLeverage, onCopyRawAll, rawLoading=false, rawCopied=false, onAutoCopyRawToggle, serverNextAt=null, onToggleAiPayloads }) => {
  // Auto Copy RAW – jednoduchý interval s odpočtem
  const [autoCopyEnabled, setAutoCopyEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('auto_copy_enabled') === '1' } catch { return false }
  })
  const [autoCopyMinutes, setAutoCopyMinutes] = useState<number>(() => {
    try { const n = Number(localStorage.getItem('auto_copy_minutes')); return Number.isFinite(n) && n >= 0 ? n : 0 } catch { return 0 }
  })
  // Persistovaný plán další akce – umožní zachovat odpočet přes reload
  const nextTsRef = useRef<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    try {
      const enabled = localStorage.getItem('auto_copy_enabled') === '1'
      if (!enabled) return 0
      const minutesRaw = Number(localStorage.getItem('auto_copy_minutes'))
      const total = Number.isFinite(minutesRaw) && minutesRaw >= 0 ? Math.floor(minutesRaw * 60) : 0
      if (total === 0) return 0
      const storedTs = Number(localStorage.getItem('auto_copy_next_ts') || '')
      const now = Date.now()
      if (Number.isFinite(storedTs) && storedTs > now) {
        nextTsRef.current = storedTs
        return Math.min(total, Math.floor((storedTs - now) / 1000))
      }
      const next = now + total * 1000
      nextTsRef.current = next
      try { localStorage.setItem('auto_copy_next_ts', String(next)) } catch {}
      return total
    } catch {
      return 0
    }
  })
  const intervalRef = useRef<number | null>(null)

  useEffect(() => {
    try { localStorage.setItem('auto_copy_enabled', autoCopyEnabled ? '1' : '0') } catch {}
    if (!autoCopyEnabled) {
      nextTsRef.current = null
      try { localStorage.removeItem('auto_copy_next_ts') } catch {}
      setSecondsLeft(0)
    }
  }, [autoCopyEnabled])
  useEffect(() => { try { localStorage.setItem('auto_copy_minutes', String(Math.max(0, Math.floor(autoCopyMinutes || 0)))) } catch {} }, [autoCopyMinutes])

  // Persist user header preferences (strictly UI prefs only)
  useEffect(() => { try { localStorage.setItem('ui_preset', String(defaultPreset)) } catch {} }, [defaultPreset])
  useEffect(() => { try { localStorage.setItem('ui_side', String(defaultSide)) } catch {} }, [defaultSide])
  useEffect(() => { try { localStorage.setItem('ui_tp_level', String(defaultTPLevel)) } catch {} }, [defaultTPLevel])
  useEffect(() => { try { localStorage.setItem('ui_amount', String(defaultAmount)) } catch {} }, [defaultAmount])
  useEffect(() => { try { localStorage.setItem('ui_leverage', String(defaultLeverage)) } catch {} }, [defaultLeverage])

  const totalSeconds = useMemo(() => Math.max(0, Math.floor((autoCopyMinutes || 0) * 60)), [autoCopyMinutes])

  // Reset/aktualizace odpočtu při změně minut
  useEffect(() => {
    if (!autoCopyEnabled || totalSeconds === 0) {
      nextTsRef.current = null
      try { localStorage.removeItem('auto_copy_next_ts') } catch {}
      setSecondsLeft(0)
      return
    }
    const now = Date.now()
    const next = now + totalSeconds * 1000
    nextTsRef.current = next
    try { localStorage.setItem('auto_copy_next_ts', String(next)) } catch {}
    setSecondsLeft(Math.max(0, Math.floor((next - now) / 1000)))
  }, [totalSeconds, autoCopyEnabled])

  // Řízení intervalu – odpočet z persistentního nextTs nebo serverNextAt
  useEffect(() => {
    if (!autoCopyEnabled) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
      setSecondsLeft(0)
      return
    }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    const tick = () => {
      const now = Date.now()
      const serverTs = (() => { try { return serverNextAt ? Date.parse(serverNextAt) : null } catch { return null } })()
      const refTs = serverTs && serverTs > now ? serverTs : (nextTsRef.current || now)
      if (!refTs || refTs <= now) { setSecondsLeft(0); return }
      setSecondsLeft(Math.floor((refTs - now) / 1000))
    }
    tick()
    intervalRef.current = window.setInterval(tick, 1000)
    return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null } }
  }, [autoCopyEnabled, totalSeconds, serverNextAt])

  // Spuštění onCopyRawAll při dosažení nuly (a není loading) – s persistencí nextTs
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!autoCopyEnabled || totalSeconds === 0) return
    if (!didMountRef.current) { didMountRef.current = true; return }
    if (secondsLeft > 0) return
    if (rawLoading) return
    const trigger = async () => {
      try { if (onCopyRawAll) await onCopyRawAll() } catch {}
      const now = Date.now()
      const next = now + totalSeconds * 1000
      nextTsRef.current = next
      try { localStorage.setItem('auto_copy_next_ts', String(next)) } catch {}
      setSecondsLeft(Math.max(0, Math.floor((next - now) / 1000)))
    }
    trigger()
  }, [secondsLeft, rawLoading, autoCopyEnabled, totalSeconds, onCopyRawAll])

  const formattedCountdown = useMemo(() => {
    const s = Math.max(0, secondsLeft)
    const m = Math.floor(s / 60)
    const r = s % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(m)}:${pad(r)}`
  }, [secondsLeft])

  return (
    <div className="space-between mb-12 no-print" style={{ paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700, color: '#dc2626' }}>SHORT</div>
        {/* Globální defaulty vlevo */}
        <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Preset:
            <select value={defaultPreset} onChange={(e)=>onChangeDefaultPreset && onChangeDefaultPreset(e.target.value as any)}>
              <option value="conservative">Conservative</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Side:
            <select value={defaultSide} onChange={(e)=>onChangeDefaultSide && onChangeDefaultSide(e.target.value as any)}>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            TP úroveň:
            <select value={defaultTPLevel} onChange={(e)=>onChangeDefaultTPLevel && onChangeDefaultTPLevel(e.target.value as any)}>
              <option value="tp1">TP1</option>
              <option value="tp2">TP2</option>
              <option value="tp3">TP3</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Částka ($):
            <input type="number" min={1} step={1} value={Number.isFinite(defaultAmount as any) ? defaultAmount : 0} onChange={(e)=>onChangeDefaultAmount && onChangeDefaultAmount(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Páka:
            <input type="number" min={1} step={1} value={Number.isFinite(defaultLeverage as any) ? defaultLeverage : 1} onChange={(e)=>onChangeDefaultLeverage && onChangeDefaultLeverage(Number(e.target.value))} style={{ width: 70 }} />
            <span style={{ opacity: .7 }}>x</span>
          </label>
          {/* Auto Copy RAW – vpravo v liště */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              Auto Copy RAW:
              <input
                type="number"
                min={0}
                step={1}
                value={autoCopyMinutes}
                onChange={(e)=>setAutoCopyMinutes(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                style={{ width: 60 }}
                title="Interval v minutách (0 = vypnuto)"
              />
              <span style={{ opacity: .8 }}>min</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={autoCopyEnabled}
                onChange={(e)=>{ setAutoCopyEnabled(e.target.checked); try { if (onAutoCopyRawToggle) onAutoCopyRawToggle(e.target.checked) } catch {} }}
                // Povolit přepínání vždy; odpočet běží jen když minuty > 0
                title={'Zapnout/vypnout auto Copy RAW'}
              />
              <span style={{ opacity: .9 }}>On</span>
            </label>
            <span style={{ fontSize: 12, opacity: .9, minWidth: 52, textAlign: 'right' }} aria-live="polite">
              {autoCopyEnabled && totalSeconds > 0 ? formattedCountdown : '—'}
            </span>
            <button
              className="btn"
              onClick={() => { if (!rawLoading && onCopyRawAll) onCopyRawAll() }}
              disabled={rawLoading}
              style={{ border: '1px solid #444' }}
              aria-label="Spustit Copy RAW nyní"
              title={rawCopied ? 'Zkopírováno' : 'Copy RAW nyní'}
            >
              {rawLoading ? 'Stahuji…' : (rawCopied ? 'RAW ✓' : 'Copy RAW')}
            </button>
            <button
              className="btn"
              onClick={() => { try { onToggleAiPayloads && onToggleAiPayloads() } catch {} }}
              style={{ border: '1px solid #444' }}
              aria-label="Open AI Payloads"
              title="AI Payloads"
            >
              AI Payloads
            </button>
          </div>
        </div>
      </div>
      {false && (
        <div>
          <label style={{ display: 'none', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Side:
            <select value={defaultSide} onChange={(e)=>onChangeDefaultSide && onChangeDefaultSide(e.target.value as any)}>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </label>
          <label style={{ display: 'none', alignItems: 'center', gap: 6, fontSize: 12 }}>
            TP úroveň:
            <select value={defaultTPLevel} onChange={(e)=>onChangeDefaultTPLevel && onChangeDefaultTPLevel(e.target.value as any)}>
              <option value="tp1">TP1</option>
              <option value="tp2">TP2</option>
              <option value="tp3">TP3</option>
            </select>
          </label>
          <label style={{ display: 'none', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Částka ($):
            <input type="number" min={1} step={1} value={Number.isFinite(defaultAmount as any) ? defaultAmount : 0} onChange={(e)=>onChangeDefaultAmount && onChangeDefaultAmount(Number(e.target.value))} style={{ width: 80 }} />
          </label>
          <label style={{ display: 'none', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Páka:
            <input type="number" min={1} step={1} value={Number.isFinite(defaultLeverage as any) ? defaultLeverage : 1} onChange={(e)=>onChangeDefaultLeverage && onChangeDefaultLeverage(Number(e.target.value))} style={{ width: 70 }} />
            <span style={{ opacity: .7 }}>x</span>
          </label>
          <label style={{ display: 'none', alignItems: 'center', gap: 6, fontSize: 12 }}>
            Preset:
            <select value={defaultPreset} onChange={(e)=>onChangeDefaultPreset && onChangeDefaultPreset(e.target.value as any)}>
              <option value="conservative">Conservative</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>
          {/* Run button intentionally not rendered */}
          <button className="btn" onClick={onExportSnapshot} disabled={running} aria-label="Export snapshot (S)" title="Export snapshot (S)">Export snapshot</button>
          <button className="btn" onClick={onExportFeatures} disabled={running} aria-label="Export features (F)" title="Export features (F)">Export features</button>
          <button className="btn" onClick={onToggleReport} aria-label={showingReport ? 'Back' : 'Open report'} title={showingReport ? 'Back' : 'Report'}>
            {showingReport ? 'Back' : 'Report'}
          </button>
          <button className="btn ghost" onClick={onToggleSettings} aria-label="Open settings" title="Settings">⚙️</button>
        </div>
      )}
    </div>
  )
}


