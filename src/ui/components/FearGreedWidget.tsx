import React, { useEffect, useMemo, useState } from 'react'

type Data = { value: number; classification: string | null; updated_at: string | null; fetched_at?: string | null }

const classifyColor = (v: number): { bg: string; fg: string } => {
  if (v >= 75) return { bg: '#14b8a6', fg: '#04201d' } // extreme greed
  if (v >= 56) return { bg: '#16a34a', fg: '#071a0f' } // greed
  if (v >= 45) return { bg: '#eab308', fg: '#1a1604' } // neutral
  if (v >= 25) return { bg: '#f97316', fg: '#1f140a' } // fear
  return { bg: '#ef4444', fg: '#1f0b0b' }             // extreme fear
}

export const FearGreedWidget: React.FC = () => {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nowTs, setNowTs] = useState<number>(() => Date.now())

  useEffect(() => {
    let mounted = true
    const load = async () => {
      try {
        const res = await fetch('/api/fear_greed')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        if (mounted) setData(j)
        try { localStorage.setItem('fg_index_last', JSON.stringify(j)) } catch {}
      } catch (e: any) {
        setError(String(e?.message || e))
        // try last known
        try { const last = localStorage.getItem('fg_index_last'); if (last && mounted) setData(JSON.parse(last)) } catch {}
      }
    }
    load()
    const id = window.setInterval(load, 20 * 60 * 1000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  const value = Number((data as any)?.value ?? NaN)
  const cls = String((data as any)?.classification || '')
  const color = useMemo(() => (Number.isFinite(value) ? classifyColor(value) : { bg: '#334155', fg: '#0b1220' }), [value])
  // Recompute relative time every minute
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])
  const updatedAgo = useMemo(() => {
    try {
      const srcTs = data?.fetched_at || data?.updated_at
      if (!srcTs) return null
      const ts = Date.parse(srcTs)
      if (!Number.isFinite(ts as any)) return null
      const diffMs = Math.max(0, nowTs - ts)
      const m = Math.floor(diffMs / 60000)
      const h = Math.floor(m / 60)
      const mm = m % 60
      if (h >= 24) {
        const d = Math.floor(h / 24)
        return `${d}d ${h % 24}h ago`
      }
      if (h > 0) return `${h}h ${mm}m ago`
      return `${m}m ago`
    } catch { return null }
  }, [data?.fetched_at, data?.updated_at, nowTs])

  return (
    <div className="card" style={{ padding: 10, minWidth: 140 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 60 }}>
          <div style={{ height: 8, borderRadius: 9999, background: '#0b1220', border: '1px solid #1f2937', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%`, height: '100%', background: color.bg }} />
          </div>
        </div>
        <div style={{ fontWeight: 700, fontSize: 18 }}>{Number.isFinite(value) ? Math.round(value) : '—'}</div>
      </div>
      <div style={{ fontSize: 12, opacity: .9, marginTop: 4 }}>{cls || '—'}</div>
      {updatedAgo && <div style={{ fontSize: 11, opacity: .7 }}>Updated {updatedAgo}</div>}
      {error && <div style={{ color: 'crimson', fontSize: 11 }}>Error: {error}</div>}
    </div>
  )
}

export default FearGreedWidget


