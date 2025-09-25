import React from 'react'

type EntryBody = { symbol: string; body: string; sentAt?: string }

export const AiPayloadsPanel: React.FC<{
  hsBody?: string | null
  entryBodies: EntryBody[]
  onClose: () => void
}> = ({ hsBody, entryBodies, onClose }) => {
  const [suSymbol, setSuSymbol] = React.useState<string>('')
  const [suBody, setSuBody] = React.useState<string>('')
  const [suLoading, setSuLoading] = React.useState<boolean>(false)
  const [suError, setSuError] = React.useState<string | null>(null)
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text) } catch {}
  }
  const ageMin = (iso?: string | null) => {
    try { if (!iso) return null; const t = Date.parse(iso); if (!Number.isFinite(t)) return null; return Math.round((Date.now() - t) / 60000) } catch { return null }
  }
  const parseSafe = (s?: string | null): any => { try { return s ? JSON.parse(s) : null } catch { return null } }
  const hsParsed = parseSafe(hsBody)

  const combinedEntryArray = (() => {
    try { return `[\n${entryBodies.map(e => e.body).join(',\n')}\n]` } catch { return '[]' }
  })()

  return (
    <div className="card" style={{ marginTop: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>AI Payloads (exact 1:1 bodies)</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>

      {/* Hot Screener payload */}
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600 }}>Hot Screener request</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, opacity: .8 }}>
              {hsParsed ? `coins: ${Array.isArray(hsParsed?.coins) ? hsParsed.coins.length : 0}` : '—'}
            </span>
            {hsBody ? <button className="btn" onClick={() => copy(hsBody)}>Copy</button> : null}
          </div>
        </div>
        <div style={{ marginTop: 6 }}>
          <pre style={{ maxHeight: 220, overflow: 'auto', fontSize: 12, background: 'rgba(255,255,255,0.02)', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
            {hsBody ? hsBody : '// No payload yet – run Copy RAW (Hot Screener) first'}
          </pre>
        </div>
      </div>

      {/* Entry Strategy payloads */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600 }}>Entry Strategy requests ({entryBodies.length})</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {entryBodies.length > 0 ? (
              <button className="btn" onClick={() => copy(combinedEntryArray)}>Copy All</button>
            ) : null}
          </div>
        </div>

        {entryBodies.length === 0 ? (
          <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>No entry payloads yet – click Analyze Selected.</div>
        ) : (
          <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
            {entryBodies.map((e, idx) => {
              const parsed = parseSafe(e.body)
              const asset = parsed?.asset_data
              const priceTs = asset?.price_ts || null
              const m15 = (asset?.ohlcv?.m15 || []) as Array<{ time: string }>
              const h1 = (asset?.ohlcv?.h1 || []) as Array<{ time: string }>
              const lastM15 = m15.length ? m15[m15.length - 1].time : null
              const lastH1 = h1.length ? h1[h1.length - 1].time : null
              const aPrice = ageMin(priceTs)
              const aM15 = ageMin(lastM15)
              const aH1 = ageMin(lastH1)
              return (
                <div key={`${e.symbol}-${idx}`} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <strong>{e.symbol}</strong>
                      <span style={{ fontSize: 12, opacity: .85 }}>sent {e.sentAt ? new Date(e.sentAt).toLocaleTimeString() : '—'}</span>
                      <span style={{ fontSize: 12, opacity: .85 }}>
                        {aPrice != null ? `price_ts ${aPrice}m` : 'price_ts —'} · {aM15 != null ? `M15 ${aM15}m` : 'M15 —'} · {aH1 != null ? `H1 ${aH1}m` : 'H1 —'}
                      </span>
                    </div>
                    <button className="btn" onClick={() => copy(e.body)}>Copy</button>
                  </div>
                  <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, background: 'rgba(255,255,255,0.02)', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
                    {e.body}
                  </pre>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Strategy Updater debug (read-only from backend) */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600 }}>Strategy Updater request (last saved)</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={suSymbol}
              onChange={e=>setSuSymbol(e.target.value.toUpperCase())}
              placeholder="e.g. GMXUSDT"
              style={{ fontSize: 12, padding: '4px 6px', width: 120 }}
            />
            <button
              className="btn"
              onClick={async()=>{
                if (!suSymbol) return
                setSuLoading(true); setSuError(null); setSuBody('')
                try {
                  const r = await fetch(`/api/debug/strategy_updater_last?symbol=${encodeURIComponent(suSymbol)}`)
                  const t = await r.text()
                  setSuBody(t)
                } catch (e: any) {
                  setSuError(String(e?.message || 'load failed'))
                } finally { setSuLoading(false) }
              }}
              disabled={suLoading}
            >{suLoading ? 'Loading…' : 'Load'}</button>
            {suBody ? <button className="btn" onClick={() => copy(suBody)}>Copy</button> : null}
          </div>
        </div>
        {suError ? <div style={{ color: 'crimson', fontSize: 12, marginTop: 6 }}>{suError}</div> : null}
        <div style={{ marginTop: 6 }}>
          <pre style={{ maxHeight: 220, overflow: 'auto', fontSize: 12, background: 'rgba(255,255,255,0.02)', padding: 8, border: '1px solid var(--border)', borderRadius: 6 }}>
            {suBody || '// Load by symbol to view last SU input'}
          </pre>
        </div>
      </div>
    </div>
  )
}


