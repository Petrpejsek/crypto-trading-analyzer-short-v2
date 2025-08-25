import React from 'react'
import type { MarketDecision } from '../../../services/decider/rules_decider'

type BtcData = {
  price?: number
  priceChange?: number
  priceChangePercent?: number
  volume24h_usd?: number
  volume24h_btc?: number
}

type EthData = {
  price?: number
  priceChange?: number
  priceChangePercent?: number
  volume24h_usd?: number
  volume24h_eth?: number
}

type Props = { 
  decision: MarketDecision; 
  rawBtcH1?: number | null;
  btc?: BtcData | null;
  eth?: EthData | null;
  timestamp?: string | null;
}

const formatNumber = (num: number | undefined | null): string => {
  if (typeof num !== 'number' || !Number.isFinite(num)) return '—'
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`
  return num.toFixed(2)
}

const formatCurrency = (num: number | undefined | null): string => {
  if (typeof num !== 'number' || !Number.isFinite(num)) return '—'
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num)
}

const formatPercent = (num: number | undefined | null): string => {
  if (typeof num !== 'number' || !Number.isFinite(num)) return '—'
  const sign = num >= 0 ? '+' : ''
  return `${sign}${num.toFixed(3)}%`
}

export const DecisionBanner: React.FC<Props> = ({ decision, rawBtcH1, btc, eth, timestamp }) => {
  const color = decision.flag === 'OK' ? '#03543f' : decision.flag === 'CAUTION' ? '#92400e' : '#9b1c1c'
  const bg = decision.flag === 'OK' ? '#e6ffed' : decision.flag === 'CAUTION' ? '#fffbea' : '#fff5f5'
  const icon = decision.flag === 'OK' ? '🟢' : decision.flag === 'CAUTION' ? '🟡' : '🔴'
  const hasGptError = (decision.reasons || []).some(r => typeof r === 'string' && r.startsWith('gpt_error:'))
  const fmtPct = (v: number | null | undefined) => (v == null || !Number.isFinite(v)) ? null : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
  const rawBtcText = fmtPct(rawBtcH1)
  const rawBtcStyle = (() => {
    if (rawBtcH1 == null || !Number.isFinite(rawBtcH1)) return { bg: '#e5e7eb', fg: '#374151', border: '#9ca3af' }
    if (rawBtcH1 >= 0.5) return { bg: '#dcfce7', fg: '#065f46', border: '#10b981' } // green
    if (rawBtcH1 <= -0.5) return { bg: '#fee2e2', fg: '#991b1b', border: '#ef4444' } // red
    return { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' } // amber
  })()
  const entryHint = (() => {
    if (decision.flag === 'NO-TRADE') return { label: 'Vstup: nevstupovat', bg: '#fee2e2', fg: '#991b1b', border: '#ef4444' }
    if (!Number.isFinite(rawBtcH1 as any)) return { label: 'Vstup: neurčeno', bg: '#e5e7eb', fg: '#374151', border: '#9ca3af' }
    if ((rawBtcH1 as number) >= 0.5) {
      return decision.flag === 'OK'
        ? { label: 'Vstup: nízké riziko (vítr v zádech)', bg: '#dcfce7', fg: '#065f46', border: '#10b981' }
        : { label: 'Vstup: střední riziko', bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' }
    }
    if ((rawBtcH1 as number) <= -0.5) return { label: 'Vstup: vysoké riziko (proti větru)', bg: '#fee2e2', fg: '#991b1b', border: '#ef4444' }
    return { label: 'Vstup: střední riziko', bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' }
  })()

  // Rizikové hodnocení na základě AI analýzy
  const getRiskLevel = (): { level: string; aiDescription: string } => {
    switch (decision.posture) {
      case 'RISK-OFF':
        return {
          level: 'Riziko vysoké',
          aiDescription: `AI doporučení na základě reálné situace (${decision.flag}, zdraví trhu: ${decision.market_health}%)`
        }
      case 'NEUTRAL':
        return {
          level: 'Riziko střední', 
          aiDescription: `AI doporučení na základě reálné situace (${decision.flag}, zdraví trhu: ${decision.market_health}%)`
        }
      case 'RISK-ON':
        return {
          level: 'Riziko nízké',
          aiDescription: `AI doporučení na základě reálné situace (${decision.flag}, zdraví trhu: ${decision.market_health}%)`
        }
      default:
        return { level: 'Riziko neurčeno', aiDescription: 'AI analýza nedostupná' }
    }
  }
  
  const riskInfo = getRiskLevel()
  const isPositive = (n: number | undefined | null) => typeof n === 'number' && n > 0
  const isNegative = (n: number | undefined | null) => typeof n === 'number' && n < 0
  const btcChangeColor = isPositive(btc?.priceChangePercent) ? '#16a34a' : isNegative(btc?.priceChangePercent) ? '#dc2626' : '#6b7280'
  const ethChangeColor = isPositive(eth?.priceChangePercent) ? '#16a34a' : isNegative(eth?.priceChangePercent) ? '#dc2626' : '#6b7280'

  // Contextový komentář k "Zdraví" a BTC režimu
  const contextHint = (() => {
    const h = Number(decision.market_health)
    const b = Number(rawBtcH1)
    const hasB = Number.isFinite(b)
    if (decision.flag === 'NO-TRADE') return { text: 'Riziko vysoké: trh nevhodný pro vstupy (NO-TRADE).', color: '#991b1b' }
    if (hasB && b <= -1.0) return { text: `Pozor: BTC rychle klesá (${b.toFixed(2)}%). Riziko zvýšené, preferuj menší sizing.`, color: '#b91c1c' }
    if (hasB && b <= -0.3) return { text: `BTC proti větru (${b.toFixed(2)}%). Zvaž konzervativní přístup.`, color: '#b45309' }
    if (hasB && Math.abs(b) < 0.3) {
      if (h >= 65) return { text: 'BTC stabilizované, tržní zdraví dobré. Mírně příznivé podmínky.', color: '#065f46' }
      if (h <= 35) return { text: 'BTC stabilizované, ale zdraví trhu slabé. Selektivně a s opatrností.', color: '#b45309' }
      return { text: 'BTC spíše stabilní. Podmínky smíšené, hledej čisté setupy.', color: '#92400e' }
    }
    if (hasB && b >= 1.0) return { text: `Silné momentum BTC (${b.toFixed(2)}%). Vítr v zádech, pozor na pullbacky.`, color: '#065f46' }
    if (hasB && b >= 0.3) return { text: `BTC zelené (${b.toFixed(2)}%). Podmínky příznivé, ale kontroluj risk.`, color: '#065f46' }
    // Bez BTC signálu – fallback dle health
    if (h >= 70) return { text: 'Tržní zdraví vysoké. Vítr v zádech.', color: '#065f46' }
    if (h <= 30) return { text: 'Tržní zdraví slabé. Riziko zvýšené.', color: '#b91c1c' }
    return { text: 'Smíšené podmínky. Řiď se kvalitou setupu a risk managementem.', color: '#92400e' }
  })()
  return (
    <div style={{ background: bg, color, border: `1px solid ${color}33`, borderRadius: 8, padding: '12px 16px', marginTop: 12 }}>
      {/* Hlavní rozhodnutí řádek */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <strong>{icon} {decision.flag}</strong>
        <span>Postoj: {decision.posture}</span>
        <span>Zdraví: {decision.market_health}%</span>
        <span>Platí do: {decision.expiry_minutes}m</span>
        <span style={{ marginLeft: 4, padding: '4px 10px', borderRadius: 9999, background: entryHint.bg, color: entryHint.fg, border: `1px solid ${entryHint.border}`, fontWeight: 700 }}>
          {entryHint.label}
        </span>
        {rawBtcText && (
          <span style={{ marginLeft: 8, padding: '4px 10px', borderRadius: 9999, background: rawBtcStyle.bg, color: rawBtcStyle.fg, border: `1px solid ${rawBtcStyle.border}`, fontWeight: 700 }}>
            BTC 1h: {rawBtcText}
          </span>
        )}
        {/* AI Risk Level */}
        <span style={{ 
          marginLeft: 'auto', 
          padding: '4px 12px', 
          borderRadius: 9999, 
          background: decision.posture === 'RISK-OFF' ? '#dc2626' : decision.posture === 'NEUTRAL' ? '#d97706' : '#16a34a',
          color: 'white',
          fontWeight: 700,
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 6
        }}>
          {riskInfo.level} <span style={{ fontSize: 10, background: 'rgba(255,255,255,0.3)', padding: '1px 4px', borderRadius: 3 }}>AI</span>
        </span>
      </div>

      {/* BTC/ETH Real-time Data řádek */}
      {(btc || eth) && (
        <div style={{ 
          display: 'flex', 
          gap: 24, 
          alignItems: 'center', 
          padding: '8px 12px', 
          background: 'rgba(255,255,255,0.6)', 
          borderRadius: 6, 
          marginBottom: 8,
          fontSize: 13,
          flexWrap: 'wrap'
        }}>
          {/* BTC Data */}
          {btc && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, color: '#f7931a' }}>₿ BTC:</span>
              <span style={{ fontWeight: 700, color: '#1f2937' }}>${formatCurrency(btc.price)} USDT</span>
              <span style={{ color: btcChangeColor, fontWeight: 500, fontSize: 11 }}>
                24h: {formatPercent(btc.priceChangePercent)} (${formatCurrency(btc.priceChange)})
              </span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                Vol: {formatNumber(btc.volume24h_btc)} BTC (${formatNumber(btc.volume24h_usd)})
              </span>
            </div>
          )}
          
          {/* ETH Data */}
          {eth && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, color: '#627eea' }}>Ξ ETH:</span>
              <span style={{ fontWeight: 700, color: '#1f2937' }}>${formatCurrency(eth.price)} USDT</span>
              <span style={{ color: ethChangeColor, fontWeight: 500, fontSize: 11 }}>
                24h: {formatPercent(eth.priceChangePercent)} (${formatCurrency(eth.priceChange)})
              </span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                Vol: {formatNumber(eth.volume24h_eth)} ETH (${formatNumber(eth.volume24h_usd)})
              </span>
            </div>
          )}
        </div>
      )}

      {/* AI popis rizika */}
      <div style={{ marginBottom: 6, fontSize: 12, opacity: 0.9, fontStyle: 'italic' }}>
        {riskInfo.aiDescription}
      </div>

      {/* Contextový komentář */}
      <div style={{ marginBottom: 6, fontSize: 13, color: contextHint.color }}>
        {contextHint.text}
      </div>
      
      {/* Důvody */}
      <div>
        {(() => {
          const mapReason = (s: string): string => {
            const t = String(s || '')
            const L = t.toLowerCase()
            if (/low\s+percentage\s+of\s+assets\s+above\s+ema50|low\s+breadth|weak\s+breadth/.test(L)) return 'nízká šířka trhu (málo nad EMA50 H1)'
            if (/btc\s+below\s+ema20/.test(L) && /ema50/.test(L)) return 'BTC pod EMA20/EMA50'
            if (/eth\s+below\s+ema20/.test(L) && /ema50/.test(L)) return 'ETH pod EMA20/EMA50'
            if (/btc\s+below\s+ema20/.test(L)) return 'BTC pod EMA20'
            if (/btc\s+below\s+ema50/.test(L)) return 'BTC pod EMA50'
            if (/eth\s+below\s+ema20/.test(L)) return 'ETH pod EMA20'
            if (/eth\s+below\s+ema50/.test(L)) return 'ETH pod EMA50'
            if (/(rsi).*(oversold)|rsi\s+below\s*30/.test(L)) return 'RSI přeprodané'
            if (/h4.*ema50.*not\s+greater\s+than\s+ema200|ema50.*<.*ema200.*h4/.test(L)) return 'H4 trend slabý (EMA50 není nad EMA200)'
            if (/high\s+vol(atility)?/.test(L)) return 'vysoká volatilita'
            if (/below\s+vwap/.test(L)) return 'pod VWAP'
            return t
          }
          const out = (decision.reasons || []).slice(0,3).map(r => mapReason(String(r||''))).join(', ')
          return <span>Důvody: {out}</span>
        })()}
      </div>
      
      {hasGptError && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#7a5b00' }}>
          GPT režim: přísný fail-closed výsledek (gpt_error). UI je funkční.
        </div>
      )}
    </div>
  )
}


