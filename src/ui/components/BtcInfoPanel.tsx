import React from 'react'

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

type MarketDecision = {
  flag: 'NO-TRADE' | 'CAUTION' | 'OK'
  posture: 'RISK-ON' | 'NEUTRAL' | 'RISK-OFF'
  market_health: number
  expiry_minutes: number
  reasons: string[]
}

type Props = {
  btc?: BtcData | null
  eth?: EthData | null
  timestamp?: string | null
  decision?: MarketDecision | null
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

const getRiskInfo = (decision: MarketDecision | null | undefined): {
  level: string
  color: string
  description: string
} => {
  if (!decision) return { level: '—', color: '#6b7280', description: 'Analýza nedostupná' }
  
  const { posture, market_health, flag, reasons } = decision
  
  switch (posture) {
    case 'RISK-OFF':
      return {
        level: 'Riziko vysoké',
        color: '#dc2626',
        description: `AI doporučení na základě reálné situace (${flag}, zdraví trhu: ${market_health}%)`
      }
    case 'NEUTRAL':
      return {
        level: 'Riziko střední',
        color: '#d97706',
        description: `AI doporučení na základě reálné situace (${flag}, zdraví trhu: ${market_health}%)`
      }
    case 'RISK-ON':
      return {
        level: 'Riziko nízké',
        color: '#16a34a',
        description: `AI doporučení na základě reálné situace (${flag}, zdraví trhu: ${market_health}%)`
      }
    default:
      return { level: '—', color: '#6b7280', description: 'Neznámý stav' }
  }
}

export const BtcInfoPanel: React.FC<Props> = ({ btc, eth, timestamp, decision }) => {
  const isPositive = (n: number | undefined | null) => typeof n === 'number' && n > 0
  const isNegative = (n: number | undefined | null) => typeof n === 'number' && n < 0
  
  const btcChangeColor = isPositive(btc?.priceChangePercent) ? '#16a34a' : isNegative(btc?.priceChangePercent) ? '#dc2626' : '#6b7280'
  const ethChangeColor = isPositive(eth?.priceChangePercent) ? '#16a34a' : isNegative(eth?.priceChangePercent) ? '#dc2626' : '#6b7280'
  
  const riskInfo = getRiskInfo(decision)
  
  const updateTime = timestamp ? new Date(timestamp).toLocaleTimeString('cs-CZ', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  }) : '—'

  return (
    <div style={{
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: '12px 16px',
      marginBottom: 12,
      display: 'flex',
      gap: 24,
      alignItems: 'center',
      fontSize: 14,
      flexWrap: 'wrap',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      {/* BTC Section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: '#f7931a' }}>₿ BTC</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>
            ${formatCurrency(btc?.price)} USDT
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, opacity: 0.8 }}>
          <span style={{ color: btcChangeColor, fontWeight: 500 }}>
            24h: {formatPercent(btc?.priceChangePercent)} (${formatCurrency(btc?.priceChange)})
          </span>
          <span>Vol: {formatNumber(btc?.volume24h_btc)} BTC</span>
          <span>Vol: ${formatNumber(btc?.volume24h_usd)}</span>
        </div>
      </div>

      {/* Separator */}
      <div style={{ width: 1, height: 40, background: '#e2e8f0', margin: '0 8px' }} />

      {/* ETH Section */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: '#627eea' }}>Ξ ETH</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>
            ${formatCurrency(eth?.price)} USDT
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, opacity: 0.8 }}>
          <span style={{ color: ethChangeColor, fontWeight: 500 }}>
            24h: {formatPercent(eth?.priceChangePercent)} (${formatCurrency(eth?.priceChange)})
          </span>
          <span>Vol: {formatNumber(eth?.volume24h_eth)} ETH</span>
          <span>Vol: ${formatNumber(eth?.volume24h_usd)}</span>
        </div>
      </div>

      {/* Risk Analysis Section */}
      <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: riskInfo.color }}>
            {riskInfo.level}
          </span>
          <span style={{ 
            fontSize: 11, 
            background: riskInfo.color, 
            color: 'white', 
            padding: '2px 6px', 
            borderRadius: 4, 
            fontWeight: 500
          }}>
            AI
          </span>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, textAlign: 'right', maxWidth: 250 }}>
          {riskInfo.description}
        </div>
        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
          Aktualizováno: {updateTime}
        </div>
      </div>
    </div>
  )
}
