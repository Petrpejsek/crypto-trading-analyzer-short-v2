import React, { useEffect, useMemo, useRef, useState } from 'react'
import { STATUS_EMOJI, TRADING_PERIODS, validateTradingConfig, type TradingPeriod, type TradingStatus } from '../lib/tradingHours/config'
import { currentBestEnd, currentPeriod, diffMsHuman, hourStatusMap, nextBestStart, pad2, pragueNow } from '../lib/tradingHours/time'

type Props = {
  floating?: boolean
}

const statusColor = (s: TradingStatus): string => (s === 'BEST' ? '#16a34a' : s === 'OK' ? '#f59e0b' : '#dc2626')
const statusBg = (s: TradingStatus): string => (s === 'BEST' ? 'rgba(22,163,74,0.12)' : s === 'OK' ? 'rgba(245,158,11,0.12)' : 'rgba(220,38,38,0.12)')

export const TradingHoursTrafficLight: React.FC<Props> = ({ floating = false }) => {

  const [nowTs, setNowTs] = useState<number>(() => Date.now())
  const TAB_WIDTH = 34
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('th_collapsed') === '1' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('th_collapsed', collapsed ? '1' : '0') } catch {} }, [collapsed])

  // Update once per minute to refresh countdown and active hour highlight
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 60000)
    return () => clearInterval(id)
  }, [])

  // Dev validation of config (coverage and overlaps)
  useEffect(() => {
    try {
      const issues = validateTradingConfig(TRADING_PERIODS)
      if (Array.isArray(issues) && issues.length) {
        // eslint-disable-next-line no-console
        console.warn('[TradingHoursTrafficLight] config issues:', issues)
      }
    } catch {}
  }, [])

  const current = useMemo(() => currentPeriod(TRADING_PERIODS, nowTs), [nowTs])
  const hourMap = useMemo(() => hourStatusMap(TRADING_PERIODS, nowTs), [nowTs])

  const header = (() => {
    const p = current
    const emoji = p ? STATUS_EMOJI[p.status] : '🔴'
    const color = p ? statusColor(p.status) : '#dc2626'
    const short = p?.short || '—'
    // Countdown
    const curBest = currentBestEnd(TRADING_PERIODS, nowTs)
    const nextBest = nextBestStart(TRADING_PERIODS, nowTs)
    let line2 = ''
    if (curBest) {
      const ms = Math.max(0, curBest.end.getTime() - nowTs)
      const { h, m } = diffMsHuman(ms)
      line2 = `Probíhá nejlepší okno – končí za ${pad2(h)}:${pad2(m)}.`
    } else if (nextBest) {
      const ms = Math.max(0, nextBest.start.getTime() - nowTs)
      const { h, m } = diffMsHuman(ms)
      line2 = `Další 🟢 za ${pad2(h)}:${pad2(m)} (start v ${pad2(nextBest.period.fromHour)}:00).`
    } else {
      line2 = '—'
    }
    return { emoji, color, short, line2 }
  })()

  const grid = useMemo(() => {
    const parts = pragueNow()
    const curHour = parts.hour
    const items: Array<{ hour: number; p: TradingPeriod | undefined; now: boolean }>
      = Array.from({ length: 24 }, (_, h) => ({ hour: h, p: hourMap[h], now: h === curHour }))
    return { items, curHour }
  }, [hourMap, nowTs])

  const dayName = useMemo(() => {
    const nowDate = new Date(nowTs)
    const pragueDay = nowDate.toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague', weekday: 'long' })
    return pragueDay.charAt(0).toUpperCase() + pragueDay.slice(1)
  }, [nowTs])

  const dayProgressPct = useMemo(() => {
    const parts = pragueNow()
    const mins = parts.hour * 60 + parts.minute
    return (mins / (24 * 60)) * 100
  }, [nowTs])

  const containerStyle: React.CSSProperties = floating ? {
    position: 'fixed',
    top: 36,
    right: 6,
    zIndex: 10001,
    background: '#0b0f16',
    border: '1px solid #1f2937',
    borderRadius: 8,
    boxShadow: '0 2px 10px rgba(0,0,0,.35)',
    padding: 8,
    width: 360,
    maxWidth: '92vw',
    transform: collapsed ? `translateX(calc(100% - ${TAB_WIDTH}px))` : 'translateX(0)',
    transition: 'transform .22s ease-in-out'
  } : { marginTop: 8 }

  const gridStyleBase: React.CSSProperties = {
    display: 'grid',
    gap: 3,
    gridTemplateColumns: 'repeat(24, minmax(12px, 1fr))'
  }

  const gridStyleMobile: React.CSSProperties = {
    display: 'grid',
    gap: 3,
    gridTemplateColumns: 'repeat(12, minmax(16px, 1fr))'
  }

  const [isMobile, setIsMobile] = useState<boolean>(() => (typeof window !== 'undefined' ? window.innerWidth < 640 : false))
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div style={containerStyle} aria-live="polite">
      {/* Pull tab */}
      <button
        onClick={() => setCollapsed(v => !v)}
        aria-label={collapsed ? 'Otevřít obchodní hodiny' : 'Skrýt obchodní hodiny'}
        title={collapsed ? 'Otevřít' : 'Skrýt'}
        style={{
          position: 'absolute',
          left: -TAB_WIDTH,
          top: 8,
          width: TAB_WIDTH,
          height: 28,
          borderTopLeftRadius: 6,
          borderBottomLeftRadius: 6,
          border: '1px solid #1f2937',
          background: '#0b0f16',
          color: '#e5e7eb',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,.25)',
          cursor: 'pointer'
        }}
      >
        {(() => {
          const s = (current?.status || 'AVOID') as TradingStatus
          return <span title={current?.short || ''} aria-hidden>{STATUS_EMOJI[s]}</span>
        })()}
      </button>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, opacity: .7, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{dayName}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ fontSize: 16 }}>{header.emoji}</span>
        <span style={{ fontWeight: 700, color: header.color }}>{current?.status || '—'}</span>
        <span style={{ fontSize: 12, opacity: .9 }}>{header.short}</span>
      </div>
      <div style={{ fontSize: 12, opacity: .9, marginTop: 2 }}>{header.line2}</div>

      {/* Kompaktní mřížka 24h: pouze hodiny s tooltipy */}
      <div style={{ marginTop: 6 }}>
        <div style={isMobile ? gridStyleMobile : gridStyleBase}>
          {grid.items.map(({ hour, p, now }) => {
            const s = (p?.status as TradingStatus) || 'AVOID'
            const color = statusColor(s)
            const aria = `Hodina ${pad2(hour)}:00–${pad2((hour+1)%24)}:00 – ${s}. ${p?.short || ''}`
            return (
              <button
                key={hour}
                title={p?.detail || ''}
                aria-label={aria}
                style={{
                  border: `1px solid ${now ? color : '#1f2937'}`,
                  borderRadius: 5,
                  padding: '2px 0',
                  background: '#0f172a',
                  color,
                  outline: 'none',
                  minHeight: 20,
                  fontSize: 10,
                  lineHeight: 1,
                }}
              >
                {pad2(hour)}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tenký progress bar přes 24h */}
      <div style={{ marginTop: 6, position: 'relative' }} aria-hidden>
        <div style={{ height: 6, borderRadius: 9999, overflow: 'hidden', border: '1px solid #1f2937', background: '#0b1220', display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)' }}>
          {Array.from({ length: 24 }, (_, h) => {
            const p = hourMap[h]
            const s = (p?.status as TradingStatus) || 'AVOID'
            const bg = s === 'BEST' ? '#16a34a' : s === 'OK' ? '#f59e0b' : '#dc2626'
            return <div key={`bar-${h}`} style={{ background: bg, opacity: 0.6 }} />
          })}
        </div>
        <div style={{ position: 'absolute', left: `${dayProgressPct}%`, top: -2, height: 10, width: 2, background: '#e5e7eb', borderRadius: 2, transform: 'translateX(-1px)' }} />
      </div>
    </div>
  )
}

export default TradingHoursTrafficLight


