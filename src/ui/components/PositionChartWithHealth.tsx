// Position Chart With Health - Wrapper with HealthSemafor
// Wraps entire TradingViewChart (including buttons) with health border

import React from 'react'
import { TradingViewChart } from './TradingViewChart'
import { HealthSemafor } from './HealthSemafor'
import { useHealthMonitor } from '../hooks/useHealthMonitor'

type PositionChartWithHealthProps = {
  symbol: string
  entryPrice: number
  currentPrice: number
  slPrice: number | null
  tpPrice: number | null
  pnlUsd: number
  pnlPct: number
  pnlPctLev: number
  slLevPct: number
  tpLevPct: number
  ageMinutes: number
  leverage: number
  availableBalance: number
  positionSizeUsd: number
  positionSide: string | null | undefined
  onClosePosition: (symbol: string, side: string | null | undefined) => void
  healthMonitorEntry?: any
  healthMonitorEnabled?: boolean
}

export const PositionChartWithHealth: React.FC<PositionChartWithHealthProps> = ({
  symbol,
  entryPrice,
  currentPrice,
  slPrice,
  tpPrice,
  pnlUsd,
  pnlPct,
  pnlPctLev,
  slLevPct,
  tpLevPct,
  ageMinutes,
  leverage,
  availableBalance,
  positionSizeUsd,
  positionSide,
  onClosePosition,
  healthMonitorEntry,
  healthMonitorEnabled
}) => {
  // Use health monitor hook
  const { health, isStale, staleReason, fullOutput } = useHealthMonitor(symbol)
  
  console.log('[POSITION_CHART_WITH_HEALTH]', { symbol, positionSide, hasOnClosePosition: !!onClosePosition })
  
  return (
    <HealthSemafor
      symbol={symbol}
      health={health ?? 0}
      isStale={isStale}
      staleReason={staleReason}
      fullOutput={fullOutput}
      workerEntry={healthMonitorEntry}
      workerEnabled={healthMonitorEnabled}
    >
      <TradingViewChart
        symbol={symbol}
        entryPrice={entryPrice}
        currentPrice={currentPrice}
        slPrice={slPrice}
        tpPrice={tpPrice}
        pnlUsd={pnlUsd}
        pnlPct={pnlPct}
        pnlPctLev={pnlPctLev}
        slLevPct={slLevPct}
        tpLevPct={tpLevPct}
        ageMinutes={ageMinutes}
        leverage={leverage}
        availableBalance={availableBalance}
        positionSizeUsd={positionSizeUsd}
        onClosePosition={() => onClosePosition(symbol, positionSide)}
      />
    </HealthSemafor>
  )
}

