import React, { useEffect, useRef, useState, useCallback } from 'react'
import * as LightweightCharts from 'lightweight-charts'
import type { 
  IChartApi, 
  ISeriesApi,
  UTCTimestamp
} from 'lightweight-charts'
import { useKlinesBatch, type Kline } from '../hooks/useKlinesBatch'
import { calculateEMA } from '../lib/indicators'
import { HealthSemafor } from './HealthSemafor'
import { useHealthMonitor } from '../hooks/useHealthMonitor'

type TradingViewChartProps = {
  symbol: string
  entryPrice: number
  currentPrice: number
  slPrice?: number | null
  tpPrice?: number | null
  pnlUsd?: number
  pnlPct?: number
  pnlPctLev?: number
  slLevPct?: number
  tpLevPct?: number
  ageMinutes?: number
  leverage?: number
  availableBalance?: number
  positionSizeUsd?: number
  onClosePosition?: (symbol: string) => void
  healthMonitorEntry?: any
  healthMonitorEnabled?: boolean
}

type CandleData = {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
}

const TradingViewChartComponent: React.FC<TradingViewChartProps> = ({
  symbol,
  entryPrice,
  currentPrice,
  slPrice: slPriceProp,
  tpPrice: tpPriceProp,
  pnlUsd = 0,
  pnlPct = 0,
  pnlPctLev = 0,
  slLevPct = 0,
  tpLevPct = 0,
  ageMinutes = 0,
  leverage = 1,
  availableBalance = 0,
  positionSizeUsd = 0,
  onClosePosition,
  healthMonitorEntry,
  healthMonitorEnabled
}) => {
  // Use health monitor hook
  const { health, isStale, staleReason, fullOutput } = useHealthMonitor(symbol)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const ema100SeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  
  const [chartError, setChartError] = useState<string | null>(null)
  const [seriesReady, setSeriesReady] = useState(false) // Track when series is ready for price lines
  
  const [timeframe, setTimeframe] = useState<'1' | '5' | '15' | '60'>('1')  // DEFAULT: 1m timeframe
  const [autoUpdate, setAutoUpdate] = useState(true) // DEFAULT: Auto-refresh ON!
  
  // CRITICAL: Local cache pro soft updates (bez API callu)
  const candlesRef = useRef<CandleData[]>([])
  const ema20DataRef = useRef<Array<{time: UTCTimestamp, value: number}>>([])
  const ema50DataRef = useRef<Array<{time: UTCTimestamp, value: number}>>([])
  const ema100DataRef = useRef<Array<{time: UTCTimestamp, value: number}>>([])
  
  // Drag & Drop state
  const [isDragging, setIsDragging] = useState(false)
  const [isHoveringLine, setIsHoveringLine] = useState(false)
  const dragTargetRef = useRef<'tp' | 'sl' | null>(null)
  const [draggedTpPrice, setDraggedTpPrice] = useState<number | null>(null)
  const [draggedSlPrice, setDraggedSlPrice] = useState<number | null>(null)
  
  // Modals
  const [showTpModal, setShowTpModal] = useState(false)
  const [showSlModal, setShowSlModal] = useState(false)
  const [showScaleInModal, setShowScaleInModal] = useState(false)
  const [scaleInPct, setScaleInPct] = useState<number>(5)
  
  // AI Analyze Entry state
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [aiSuggestedPrice, setAiSuggestedPrice] = useState<number | null>(null)
  const [isProfitTakerRunning, setIsProfitTakerRunning] = useState(false)
  const [showAiModal, setShowAiModal] = useState(false)
  const [aiModalData, setAiModalData] = useState<any>(null)
  const aiLineRef = useRef<any>(null)
  
  // AI Profit Taker Modal state
  const [showProfitTakerModal, setShowProfitTakerModal] = useState(false)
  const [profitTakerResult, setProfitTakerResult] = useState<any>(null)
  
  // Local SL/TP state (can be updated from drag or API)
  const [slPrice, setSlPrice] = useState(slPriceProp ?? null)
  const [tpPrice, setTpPrice] = useState(tpPriceProp ?? null)
  
  // Price line refs
  const entryLineRef = useRef<any>(null)
  const slLineRef = useRef<any>(null)
  const tpLineRef = useRef<any>(null)
  
  // Update local state when props change
  useEffect(() => { setSlPrice(slPriceProp ?? null) }, [slPriceProp])
  useEffect(() => { setTpPrice(tpPriceProp ?? null) }, [tpPriceProp])
  
  // Convert timeframe string to interval
  const interval = timeframe === '60' ? '1h' : timeframe === '15' ? '15m' : timeframe === '5' ? '5m' : '1m'
  
  // Fetch klines
  const { data, loading, error, refetch } = useKlinesBatch([symbol], interval, 500)
  const klines = data[symbol] || []
  
  // DEBUG: Log klines data (pouze když se mění počet)
  useEffect(() => {
    if (klines.length > 0) {
      console.log('[TRADING_CHART] Klines loaded:', {
        symbol,
        count: klines.length,
        interval,
        timeRange: klines.length > 0 ? {
          from: new Date(klines[0].openTime).toISOString(),
          to: new Date(klines[klines.length - 1].openTime).toISOString()
        } : null
      })
    }
  }, [klines.length, symbol, interval])
  
  // CRITICAL: Soft update function (musí být definován PŘED useEffect který ho používá)
  const softUpdateLastCandle = useCallback(() => {
    const series = candlestickSeriesRef.current
    const candles = candlesRef.current
    
    console.log('[SOFT_UPDATE] 🔄 Called with:', {
      hasSeries: !!series,
      candlesCount: candles?.length,
      currentPrice,
      timeframe
    })
    
    if (!series || !candles || candles.length === 0) {
      console.error('[SOFT_UPDATE] ❌ Missing refs:', { 
        series: !!series, 
        candlesLength: candles?.length,
        candlesRef: candlesRef.current?.length
      })
      return
    }
    
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      console.error('[SOFT_UPDATE] ❌ Invalid currentPrice:', {
        currentPrice,
        isFinite: Number.isFinite(currentPrice),
        isPositive: currentPrice > 0
      })
      return
    }
    
    // Time bucketing - důležité pro správné timeframe alignment
    const tfSeconds = Number(timeframe) * 60  // '5' → 300 seconds
    const nowMs = Date.now()
    const nowBucket = Math.floor(nowMs / 1000 / tfSeconds) * tfSeconds as UTCTimestamp
    
    const lastCandle = candles[candles.length - 1]
    
    console.log('[SOFT_UPDATE] 📊 Candle update:', {
      symbol,
      lastCandleTime: new Date(lastCandle.time * 1000).toISOString(),
      lastCandleTimeRaw: lastCandle.time,
      nowBucket,
      nowBucketISO: new Date(nowBucket * 1000).toISOString(),
      currentPrice,
      currentPriceFormatted: currentPrice.toFixed(6),
      lastClose: lastCandle.close.toFixed(6),
      action: lastCandle.time === nowBucket ? 'UPDATE' : 'APPEND',
      tfSeconds
    })
    
    if (lastCandle.time === nowBucket) {
      // UPDATE existing candle (stejný time bucket)
      const updatedCandle: CandleData = {
        time: nowBucket,
        open: lastCandle.open,                          // KEEP original open
        high: Math.max(lastCandle.high, currentPrice),  // Update high
        low: Math.min(lastCandle.low, currentPrice),    // Update low
        close: currentPrice                             // Update close
      }
      
      series.update(updatedCandle)  // Incremental update (no flicker)
      candles[candles.length - 1] = updatedCandle  // Update cache
      
      console.log('[SOFT_UPDATE] ✅ Updated existing candle:', {
        time: new Date(updatedCandle.time * 1000).toISOString(),
        open: updatedCandle.open.toFixed(6),
        high: updatedCandle.high.toFixed(6),
        low: updatedCandle.low.toFixed(6),
        close: updatedCandle.close.toFixed(6)
      })
    } else {
      // APPEND new candle (nový time bucket)
      const newCandle: CandleData = {
        time: nowBucket,
        open: currentPrice,
        high: currentPrice,
        low: currentPrice,
        close: currentPrice
      }
      
      series.update(newCandle)  // Append new candle
      candles.push(newCandle)   // Update cache
      
      console.log('[SOFT_UPDATE] ✅ Appended new candle:', {
        time: new Date(newCandle.time * 1000).toISOString(),
        price: newCandle.close.toFixed(6)
      })
    }
  }, [currentPrice, timeframe, symbol])
  
  // CRITICAL: Soft update chart when currentPrice changes (with auto-update ON)
  useEffect(() => {
    console.log('[TRADING_CHART] 💰 CurrentPrice update:', {
      symbol,
      currentPrice,
      isValid: Number.isFinite(currentPrice) && currentPrice > 0,
      autoUpdate
    })
    
    // If auto-update is enabled, update the chart with new price
    if (autoUpdate && Number.isFinite(currentPrice) && currentPrice > 0) {
      softUpdateLastCandle() // No parameter - uses currentPrice from scope
    }
  }, [currentPrice, symbol, autoUpdate, softUpdateLastCandle])
  
  // Initialize chart
  useEffect(() => {
    // Debounce initialization to prevent race conditions when multiple charts render
    const initTimeout = setTimeout(() => {
      try {
        if (!containerRef.current) {
          console.error('[TRADING_CHART] Container ref is not available')
          setChartError('Chart container not found')
          return
        }
        
        console.log('[TRADING_CHART] Initializing chart for', symbol)
        
        // Cleanup any existing chart first
        if (chartRef.current) {
          try {
            chartRef.current.remove()
          } catch (e) {
            console.warn('[TRADING_CHART] Error removing old chart:', e)
          }
          chartRef.current = null
          candlestickSeriesRef.current = null
          ema20SeriesRef.current = null
          ema50SeriesRef.current = null
          ema100SeriesRef.current = null
        }
        
        // Clear container completely
        if (containerRef.current) {
          containerRef.current.innerHTML = ''
        }
        
        // CRITICAL FIX: Use requestAnimationFrame for proper DOM synchronization
        try {
          const chart = LightweightCharts.createChart(containerRef.current, {
            width: 550,
            height: 363,
            layout: {
              background: { type: LightweightCharts.ColorType.Solid, color: '#0f172a' },
              textColor: '#9ca3af'
            },
            grid: {
              vertLines: { color: '#1e293b' },
              horzLines: { color: '#1e293b' }
            },
            timeScale: {
              timeVisible: true,
              secondsVisible: false
            },
            rightPriceScale: {
              scaleMargins: { top: 0.1, bottom: 0.2 }
            },
            crosshair: {
              mode: 1 // CrosshairMode.Normal
            },
            localization: {
              priceFormatter: (price: number) => {
                // 2️⃣ FIX: 6 decimal places precision
                return price.toFixed(6)
              }
            }
          })
          
          if (!chart) {
            throw new Error('Chart creation returned null')
          }
          
          chartRef.current = chart
          console.log('[TRADING_CHART] Chart instance created, waiting for DOM sync...')
          
          // Use requestAnimationFrame to wait for next paint cycle
          // This ensures DOM is fully settled before adding series
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!chartRef.current) {
                console.warn('[TRADING_CHART] Chart ref lost during initialization')
                return
              }
              
              try {
                console.log('[TRADING_CHART] Adding series to chart...')
                
                // Add candlestick series (V5 API - use addSeries with class)
                const candleSeries = chartRef.current.addSeries(LightweightCharts.CandlestickSeries, {
                  upColor: '#26a69a',
                  downColor: '#ef5350',
                  borderUpColor: '#26a69a',
                  borderDownColor: '#ef5350',
                  wickUpColor: '#26a69a',
                  wickDownColor: '#ef5350'
                })
                candlestickSeriesRef.current = candleSeries
                console.log('[TRADING_CHART] ✅ Candlestick series added')
                
                // Add EMA series (V5 API - use addSeries with class)
                const ema20 = chartRef.current.addSeries(LightweightCharts.LineSeries, {
                  color: '#60a5fa',
                  lineWidth: 2,
                  crosshairMarkerVisible: false,
                  lastValueVisible: false,
                  priceLineVisible: false
                })
                ema20SeriesRef.current = ema20
                console.log('[TRADING_CHART] ✅ EMA20 series added')
                
                const ema50 = chartRef.current.addSeries(LightweightCharts.LineSeries, {
                  color: '#f97316',
                  lineWidth: 2,
                  crosshairMarkerVisible: false,
                  lastValueVisible: false,
                  priceLineVisible: false
                })
                ema50SeriesRef.current = ema50
                console.log('[TRADING_CHART] ✅ EMA50 series added')
                
                const ema100 = chartRef.current.addSeries(LightweightCharts.LineSeries, {
                  color: '#a78bfa',
                  lineWidth: 2,
                  crosshairMarkerVisible: false,
                  lastValueVisible: false,
                  priceLineVisible: false
                })
                ema100SeriesRef.current = ema100
                console.log('[TRADING_CHART] ✅ EMA100 series added')
                
                setChartError(null)
                setSeriesReady(true) // Signal that series is ready for price lines
                console.log('[TRADING_CHART] ✅ Chart initialized successfully')
              } catch (seriesError: any) {
                console.error('[TRADING_CHART] ❌ Error adding series:', seriesError)
                setChartError(`Failed to add chart series: ${seriesError?.message || 'Unknown'}`)
              }
            })
          })
          
        } catch (chartError: any) {
          console.error('[TRADING_CHART] ❌ Error creating chart:', chartError)
          setChartError(`Chart creation failed: ${chartError?.message || 'Unknown'}`)
        }
      } catch (e: any) {
        console.error('[TRADING_CHART] Fatal error during initialization:', e)
        setChartError(`Chart initialization failed: ${e?.message || 'Unknown error'}`)
      }
    }, 50) // 50ms debounce to prevent simultaneous initialization
    
    // Cleanup when component unmounts or symbol changes
    return () => {
      clearTimeout(initTimeout)
      console.log('[TRADING_CHART] Cleanup called for', symbol)
      
      if (chartRef.current) {
        try {
          chartRef.current.remove()
          console.log('[TRADING_CHART] Chart removed successfully')
        } catch (e) {
          console.warn('[TRADING_CHART] Error during cleanup:', e)
        }
        chartRef.current = null
      }
      
      candlestickSeriesRef.current = null
      ema20SeriesRef.current = null
      ema50SeriesRef.current = null
      ema100SeriesRef.current = null
      setSeriesReady(false) // Reset series ready state
    }
  }, [symbol, interval])
  
  // 1️⃣ INICIÁLNÍ NAČTENÍ - setData() (kompletní replace)
  useEffect(() => {
    console.log('[TRADING_CHART] Load data effect triggered:', {
      symbol,
      seriesReady,
      hasSeries: !!candlestickSeriesRef.current,
      klinesLength: klines.length
    })
    
    // CRITICAL: Wait for series to be fully initialized before loading data
    if (!seriesReady || !candlestickSeriesRef.current) {
      console.warn('[TRADING_CHART] ⚠️ Series not ready, skipping data load')
      return
    }
    if (klines.length === 0) {
      console.warn('[TRADING_CHART] ⚠️ No klines data available for', symbol)
      return
    }
    
    console.log('[TRADING_CHART] 🎯 Loading', klines.length, 'candles into chart (FULL REFRESH)...')
    
    // Transform klines to LightweightCharts format
    const candleData: CandleData[] = klines.map((k: Kline) => ({
      time: (k.openTime / 1000) as UTCTimestamp, // ms → seconds CRITICAL!
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close)
    }))
    
    // setData() = KOMPLETNÍ REPLACE (používá se při mount/timeframe změně)
    candlestickSeriesRef.current.setData(candleData)
    
    // Uložit do cache pro soft updates
    candlesRef.current = candleData
    
    console.log('[TRADING_CHART] 📦 Cached', candleData.length, 'candles for soft updates')
    
    // Calculate and set EMA data
    const closes = candleData.map(c => c.close)
    
    const ema20Values = calculateEMA(closes, 20)
    const ema50Values = calculateEMA(closes, 50)
    const ema100Values = calculateEMA(closes, 100)
    
    const ema20Data = ema20Values
      .map((v, i) => ({ time: candleData[i].time as UTCTimestamp, value: v as number }))
      .filter(d => d.value !== null)
    
    const ema50Data = ema50Values
      .map((v, i) => ({ time: candleData[i].time as UTCTimestamp, value: v as number }))
      .filter(d => d.value !== null)
    
    const ema100Data = ema100Values
      .map((v, i) => ({ time: candleData[i].time as UTCTimestamp, value: v as number }))
      .filter(d => d.value !== null)
    
    // Cache EMA data
    ema20DataRef.current = ema20Data
    ema50DataRef.current = ema50Data
    ema100DataRef.current = ema100Data
    
    if (ema20SeriesRef.current) ema20SeriesRef.current.setData(ema20Data)
    if (ema50SeriesRef.current) ema50SeriesRef.current.setData(ema50Data)
    if (ema100SeriesRef.current) ema100SeriesRef.current.setData(ema100Data)
    
    console.log('[TRADING_CHART] ✅ Chart data loaded successfully')
  }, [klines, symbol, seriesReady])
  
  // Create/Update Price Lines
  useEffect(() => {
    console.log('[PRICE_LINES] Effect triggered:', {
      seriesReady,
      hasSeries: !!candlestickSeriesRef.current,
      entryPrice,
      slPrice,
      tpPrice,
      entryValid: Number.isFinite(entryPrice) && entryPrice > 0,
      slValid: Number.isFinite(slPrice as any) && (slPrice as number) > 0,
      tpValid: Number.isFinite(tpPrice as any) && (tpPrice as number) > 0
    })
    
    if (!seriesReady || !candlestickSeriesRef.current) {
      console.warn('[PRICE_LINES] ⚠️ Series not ready yet')
      return
    }
    const series = candlestickSeriesRef.current
    
    try {
      // Remove old lines
      if (entryLineRef.current) {
        try { series.removePriceLine(entryLineRef.current) } catch {}
        entryLineRef.current = null
      }
      if (slLineRef.current) {
        try { series.removePriceLine(slLineRef.current) } catch {}
        slLineRef.current = null
      }
      if (tpLineRef.current) {
        try { series.removePriceLine(tpLineRef.current) } catch {}
        tpLineRef.current = null
      }
      
      console.log('[PRICE_LINES] 🗑️ Old lines removed')
      
      // Entry line (blue, dashed)
      if (Number.isFinite(entryPrice) && entryPrice > 0) {
        try {
          entryLineRef.current = series.createPriceLine({
            price: entryPrice,
            color: '#60a5fa',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Entry: ${entryPrice.toFixed(6)}`
          })
          console.log('[PRICE_LINES] ✅ Entry line created:', entryPrice)
        } catch (e) {
          console.error('[ENTRY_LINE_ERROR]', e)
        }
      } else {
        console.log('[PRICE_LINES] ⏭️ Skipping entry line (invalid price)')
      }
      
      // SL line (red, dashed)
      if (Number.isFinite(slPrice as any) && (slPrice as number) > 0) {
        try {
          slLineRef.current = series.createPriceLine({
            price: slPrice as number,
            color: '#ef4444',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `SL: ${(slPrice as number).toFixed(6)}`
          })
          console.log('[PRICE_LINES] ✅ SL line created:', slPrice)
        } catch (e) {
          console.error('[SL_LINE_ERROR]', e)
        }
      } else {
        console.log('[PRICE_LINES] ⏭️ Skipping SL line (invalid price)')
      }
      
      // TP line (green, dashed)
      if (Number.isFinite(tpPrice as any) && (tpPrice as number) > 0) {
        try {
          tpLineRef.current = series.createPriceLine({
            price: tpPrice as number,
            color: '#10b981',
            lineWidth: 2,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP: ${(tpPrice as number).toFixed(6)}`
          })
          console.log('[PRICE_LINES] ✅ TP line created:', tpPrice)
        } catch (e) {
          console.error('[TP_LINE_ERROR]', e)
        }
      } else {
        console.log('[PRICE_LINES] ⏭️ Skipping TP line (invalid price)')
      }
    } catch (e) {
      console.error('[PRICE_LINES_ERROR]', e)
    }
  }, [seriesReady, entryPrice, slPrice, tpPrice])
  
  // Drag & Drop Handlers
  useEffect(() => {
    if (!containerRef.current || !candlestickSeriesRef.current || !chartRef.current) return
    
    const container = containerRef.current
    const series = candlestickSeriesRef.current
    const chart = chartRef.current
    let isPointerDown = false
    
    console.log('[DRAG_DROP] Initializing drag & drop handlers', { 
      hasContainer: !!container, 
      hasSeries: !!series, 
      hasChart: !!chart,
      tpPrice,
      slPrice
    })
    
    const handleMouseDown = (e: MouseEvent) => {
      if (!series || !chart) return
      
      const rect = container.getBoundingClientRect()
      const y = e.clientY - rect.top
      
      console.log('[DRAG_MOUSEDOWN] Click detected at Y:', y)
      
      try {
        // FIXED: Use chart.priceScale() instead of series.coordinateToPrice()
        const priceScale = chart.priceScale()
        if (!priceScale) {
          console.warn('[DRAG_MOUSEDOWN] Price scale not available')
          return
        }
        
        const priceAtY = priceScale.coordinateToPrice(y)
        if (!priceAtY || !Number.isFinite(priceAtY)) {
          console.warn('[DRAG_MOUSEDOWN] Invalid price at Y:', priceAtY)
          return
        }
        
        console.log('[DRAG_MOUSEDOWN] Price at Y:', priceAtY, 'TP:', tpPrice, 'SL:', slPrice)
        
        // Tolerance ±0.5%
        const tpTol = (tpPrice ?? 0) * 0.005
        const slTol = (slPrice ?? 0) * 0.005
        
        const tpDistance = tpPrice ? Math.abs(priceAtY - tpPrice) : Infinity
        const slDistance = slPrice ? Math.abs(priceAtY - slPrice) : Infinity
        
        console.log('[DRAG_MOUSEDOWN] Distances - TP:', tpDistance, '(tol:', tpTol, ') SL:', slDistance, '(tol:', slTol, ')')
        
        if (tpPrice && tpDistance <= tpTol) {
          console.log('[DRAG_MOUSEDOWN] ✅ TP line grabbed!')
          dragTargetRef.current = 'tp'
          isPointerDown = true
          setIsDragging(true)
        } else if (slPrice && slDistance <= slTol) {
          console.log('[DRAG_MOUSEDOWN] ✅ SL line grabbed!')
          dragTargetRef.current = 'sl'
          isPointerDown = true
          setIsDragging(true)
        } else {
          console.log('[DRAG_MOUSEDOWN] ❌ No line close enough to grab')
        }
      } catch (e) {
        console.error('[DRAG_MOUSEDOWN_ERROR]', e)
      }
    }
    
    const handleMouseMove = (e: MouseEvent) => {
      if (!series || !chart) return
      
      const rect = container.getBoundingClientRect()
      const y = e.clientY - rect.top
      
      // FIXED: Use chart.priceScale() for hover detection too
      try {
        const priceScale = chart.priceScale()
        if (!priceScale) return
        
        const priceAtY = priceScale.coordinateToPrice(y)
        if (!priceAtY || !Number.isFinite(priceAtY)) return
        
        // If dragging, update the line
        if (isPointerDown && dragTargetRef.current) {
          console.log('[DRAG_MOUSEMOVE] Dragging', dragTargetRef.current, 'to price:', priceAtY)
          
          // Update visual line (thicker, solid)
          if (dragTargetRef.current === 'tp') {
            if (tpLineRef.current) {
              try { series.removePriceLine(tpLineRef.current) } catch {}
            }
            tpLineRef.current = series.createPriceLine({
              price: priceAtY,
              color: '#10b981',
              lineWidth: 3,
              lineStyle: LightweightCharts.LineStyle.Solid,
              axisLabelVisible: true,
              title: `TP: ${priceAtY.toFixed(6)} (dragging)`
            })
            setDraggedTpPrice(priceAtY)
          } else if (dragTargetRef.current === 'sl') {
            if (slLineRef.current) {
              try { series.removePriceLine(slLineRef.current) } catch {}
            }
            slLineRef.current = series.createPriceLine({
              price: priceAtY,
              color: '#ef4444',
              lineWidth: 3,
              lineStyle: LightweightCharts.LineStyle.Solid,
              axisLabelVisible: true,
              title: `SL: ${priceAtY.toFixed(6)} (dragging)`
            })
            setDraggedSlPrice(priceAtY)
          }
        } else {
          // Hover detection for cursor feedback
          const tpTol = (tpPrice ?? 0) * 0.005
          const slTol = (slPrice ?? 0) * 0.005
          
          const nearTp = tpPrice && Math.abs(priceAtY - tpPrice) <= tpTol
          const nearSl = slPrice && Math.abs(priceAtY - slPrice) <= slTol
          
          if (nearTp || nearSl) {
            if (!isHoveringLine) {
              setIsHoveringLine(true)
              container.style.cursor = 'ns-resize'
            }
          } else {
            if (isHoveringLine) {
              setIsHoveringLine(false)
              container.style.cursor = 'default'
            }
          }
        }
      } catch (e) {
        console.error('[DRAG_MOUSEMOVE_ERROR]', e)
      }
    }
    
    const handleMouseUp = () => {
      if (!isPointerDown) return
      
      console.log('[DRAG_MOUSEUP] Released', dragTargetRef.current, 'TP:', draggedTpPrice, 'SL:', draggedSlPrice)
      
      isPointerDown = false
      setIsDragging(false)
      container.style.cursor = 'default'
      setIsHoveringLine(false)
      
      if (dragTargetRef.current === 'tp' && draggedTpPrice) {
        console.log('[DRAG_MOUSEUP] ✅ Opening TP modal')
        setShowTpModal(true)
      } else if (dragTargetRef.current === 'sl' && draggedSlPrice) {
        console.log('[DRAG_MOUSEUP] ✅ Opening SL modal')
        setShowSlModal(true)
      }
      
      dragTargetRef.current = null
    }
    
    container.addEventListener('mousedown', handleMouseDown)
    container.addEventListener('mousemove', handleMouseMove)
    container.addEventListener('mouseup', handleMouseUp)
    
    return () => {
      container.removeEventListener('mousedown', handleMouseDown)
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseup', handleMouseUp)
      container.style.cursor = 'default'
    }
  }, [slPrice, tpPrice, draggedTpPrice, draggedSlPrice, isHoveringLine])
  
  // Auto-refresh interval (když Auto: ON)
  useEffect(() => {
    if (!autoUpdate) {
      console.log('[AUTO_REFRESH] Auto-update disabled')
      return
    }
    
    console.log('[AUTO_REFRESH] Starting auto-refresh interval (5s)')
    
    const interval = setInterval(() => {
      console.log('[AUTO_REFRESH] Triggering soft update...')
      softUpdateLastCandle()
    }, 5000)  // Každých 5 sekund
    
    return () => {
      console.log('[AUTO_REFRESH] Clearing auto-refresh interval')
      clearInterval(interval)
    }
  }, [autoUpdate, softUpdateLastCandle])
  
  // API Handlers
  const handleConfirmTp = async () => {
    if (!draggedTpPrice) return
    
    try {
      const res = await fetch('/api/manual_tp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, tpPrice: draggedTpPrice })
      })
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || 'Unknown error')
      
      // Success
      setTpPrice(draggedTpPrice)
      setShowTpModal(false)
      setDraggedTpPrice(null)
    } catch (e: any) {
      alert(`TP Change Error: ${e?.message || 'Unknown error'}`)
    }
  }
  
  const handleConfirmSl = async () => {
    if (!draggedSlPrice) return
    
    try {
      const res = await fetch('/api/manual_sl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, slPrice: draggedSlPrice })
      })
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || 'Unknown error')
      
      // Success
      setSlPrice(draggedSlPrice)
      setShowSlModal(false)
      setDraggedSlPrice(null)
    } catch (e: any) {
      alert(`SL Change Error: ${e?.message || 'Unknown error'}`)
    }
  }
  
  const handleCancelTp = () => {
    setShowTpModal(false)
    setDraggedTpPrice(null)
    // Restore original line
    if (candlestickSeriesRef.current && tpLineRef.current) {
      try { candlestickSeriesRef.current.removePriceLine(tpLineRef.current) } catch {}
    }
    if (candlestickSeriesRef.current && tpPrice) {
      tpLineRef.current = candlestickSeriesRef.current.createPriceLine({
        price: tpPrice,
        color: '#10b981',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `TP: ${tpPrice.toFixed(6)}`
      })
    }
  }
  
  const handleCancelSl = () => {
    setShowSlModal(false)
    setDraggedSlPrice(null)
    // Restore original line
    if (candlestickSeriesRef.current && slLineRef.current) {
      try { candlestickSeriesRef.current.removePriceLine(slLineRef.current) } catch {}
    }
    if (candlestickSeriesRef.current && slPrice) {
      slLineRef.current = candlestickSeriesRef.current.createPriceLine({
        price: slPrice,
        color: '#ef4444',
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true,
        title: `SL: ${slPrice.toFixed(6)}`
      })
    }
  }
  
  // AI Analyze Entry handlers
  const removeAiLine = () => {
    if (candlestickSeriesRef.current && aiLineRef.current) {
      try {
        candlestickSeriesRef.current.removePriceLine(aiLineRef.current)
        aiLineRef.current = null
      } catch {}
    }
  }
  
  const showAiSuggestedLine = (price: number, draggable: boolean = true) => {
    if (!candlestickSeriesRef.current) return
    
    removeAiLine()
    
    aiLineRef.current = candlestickSeriesRef.current.createPriceLine({
      price,
      color: '#8b5cf6',
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: `AI Entry: ${price.toFixed(6)}`
    })
  }
  
  const handleProfitTakerClick = async () => {
    const timestamp = new Date().toISOString()
    console.log('[AI_PT_UI_TRIGGER]', { symbol, timestamp, isProfitTakerRunning })
    
    if (isProfitTakerRunning || !symbol) {
      console.warn('[AI_PT_BLOCKED]', { reason: isProfitTakerRunning ? 'already_running' : 'no_symbol' })
      return
    }
    
    setIsProfitTakerRunning(true)
    const startTime = performance.now()
    
    try {
      console.info('[AI_PT_REQUEST_START]', { symbol, timestamp })
      
      const res = await fetch('/api/ai_profit_taker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
      })
      
      const data = await res.json()
      const latency = Math.round(performance.now() - startTime)
      
      console.info('[AI_PT_RESPONSE]', { 
        symbol, 
        ok: res.ok, 
        status: res.status,
        latency_ms: latency,
        data 
      })
      
      if (!res.ok) {
        console.error('[AI_PT_HTTP_ERROR]', { status: res.status, data })
        setProfitTakerResult({
          success: false,
          error: data.error || data.code || 'Unknown error',
          latency
        })
        setShowProfitTakerModal(true)
        return
      }
      
      if (data.ok && data.data?.decision?.action === 'adjust_exits') {
        const decision = data.data.decision
        console.log('[AI_PT_SUCCESS_ADJUST]', { symbol, decision, latency_ms: latency })
        
        setProfitTakerResult({
          success: true,
          action: 'adjust_exits',
          decision,
          latency,
          symbol
        })
        setShowProfitTakerModal(true)
      } else if (data.ok && data.data?.decision?.action === 'skip') {
        const decision = data.data.decision
        console.log('[AI_PT_SUCCESS_SKIP]', { symbol, rationale: decision.rationale, latency_ms: latency })
        
        setProfitTakerResult({
          success: true,
          action: 'skip',
          decision,
          latency,
          symbol
        })
        setShowProfitTakerModal(true)
      } else if (!data.ok) {
        const code = data.code || 'unknown'
        const reason = data.meta?.reason || data.meta?.error || 'No details available'
        
        console.error('[AI_PT_FAILED]', { symbol, code, reason, latency_ms: latency })
        
        // User-friendly error messages
        let userMessage = ''
        if (code === 'no_position') {
          userMessage = 'Není otevřená SHORT pozice pro tento symbol'
        } else if (code === 'no_api_key') {
          userMessage = 'Chybí OpenAI API klíč - zkontroluj konfiguraci'
        } else if (code === 'timeout') {
          userMessage = 'OpenAI API timeout - zkus to znovu'
        } else if (code === 'schema') {
          userMessage = 'GPT vrátil nevalidní JSON - možná chyba v promptu'
        } else {
          userMessage = reason
        }
        
        setProfitTakerResult({
          success: false,
          code,
          error: userMessage,
          latency,
          symbol
        })
        setShowProfitTakerModal(true)
      }
    } catch (e: any) {
      const latency = Math.round(performance.now() - startTime)
      console.error('[AI_PT_EXCEPTION]', { symbol, error: e?.message, stack: e?.stack, latency_ms: latency })
      setProfitTakerResult({
        success: false,
        error: `Neočekávaná chyba: ${e?.message || 'Unknown error'}`,
        latency,
        symbol
      })
      setShowProfitTakerModal(true)
    } finally {
      setIsProfitTakerRunning(false)
      console.info('[AI_PT_UI_COMPLETE]', { symbol, timestamp: new Date().toISOString() })
    }
  }
  
  const handleAnalyzeClick = async () => {
    console.log('[AI_ANALYZE_START]', { symbol, isAnalyzing })
    if (isAnalyzing) return
    
    setIsAnalyzing(true)
    
    // Cleanup old lines
    removeAiLine()
    
    // Create timeout controller
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
      console.log('[AI_ANALYZE_TIMEOUT]', { symbol, after: '60s' })
    }, 60000)
    
    try {
      // 1. Fetch snapshot
      const snapshotUrl = `/api/reactive-entry/snapshot?symbol=${symbol}&micro_range=1&ui_lang=cs`
      const snapshotRes = await fetch(snapshotUrl, { signal: controller.signal })
      
      if (!snapshotRes.ok) throw new Error(`Snapshot HTTP ${snapshotRes.status}`)
      
      const snapshot = await snapshotRes.json()
      
      if (!snapshot.ok) {
        alert(`❌ Snapshot Error: ${snapshot.error}`)
        return
      }
      
      // 2. Call analyze
      const analyzeRes = await fetch('/api/reactive-entry/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
        signal: controller.signal
      })
      
      if (!analyzeRes.ok) {
        let errorMsg = `HTTP ${analyzeRes.status}`
        try {
          const errorData = await analyzeRes.json()
          errorMsg = errorData.error || errorData.code || errorMsg
        } catch {}
        throw new Error(errorMsg)
      }
      
      const result = await analyzeRes.json()
      
      if (!result.ok) {
        throw new Error(result.error || result.code || 'AI analysis failed')
      }
      
      // 3. Log complete data
      console.log('=== REACTIVE ENTRY RAW ===', { 
        snapshot_input: snapshot, 
        openai_request: result.raw_request, 
        openai_response: result.raw_response,
        server_output: result 
      })
      
      // 4. Copy to clipboard
      try {
        const completeData = {
          snapshot_input: snapshot,
          openai_request: result.raw_request || null,
          openai_response: result.raw_response || null,
          server_output: result
        }
        await navigator.clipboard.writeText(JSON.stringify(completeData, null, 2))
        console.log('✅ KOMPLETNÍ DATA ZKOPÍROVÁNA')
      } catch (e) {
        console.error('❌ Clipboard error:', e)
      }
      
      // 5. Handle result
      if (result.decision === 'entry' || result.atr_info?.proper_entry) {
        const entryPrice = result.atr_info?.proper_entry || result.entry?.price || 0
        
        // Recovery threshold check (70% minimum)
        let recovery = result.confidence ?? 0
        if (recovery > 1) recovery = recovery / 100 // Normalize
        const isRecoveryOK = recovery >= 0.70
        
        // Set suggested price
        setAiSuggestedPrice(entryPrice)
        
        // Show entry line on chart
        removeAiLine()
        setTimeout(() => {
          showAiSuggestedLine(entryPrice, true)
        }, 50)
        
        // Build reasoning
        let reasoningText = result.reasoning || ''
        if (result.atr_info) {
          reasoningText += `\n\n📊 Entry logika:\n`
          reasoningText += `• Resistance: ${result.atr_info.resistance_used?.toFixed(5) || 'N/A'}\n`
          reasoningText += `• ATR buffer: 0.25x (${result.atr_info.atr_buffer?.toFixed(5) || 'N/A'})\n`
          reasoningText += `• Recovery: ${(recovery * 100).toFixed(1)}% ${isRecoveryOK ? '✅' : '❌ (min 70%)'}\n`
        }
        
        // Show modal
        setAiModalData({
          decision: result.decision,
          confidence: recovery,
          mode: result.mode,
          class: result.class,
          size_hint_pct: result.size_hint_pct,
          entry: { type: 'limit', price: entryPrice },
          reasoning: reasoningText,
          suggestion: result.suggestion,
          diagnostics: result.diagnostics
        })
        setShowAiModal(true)
      } else {
        // SKIP decision
        alert(`⏭️ AI Skip\n\n${result.reasoning}`)
      }
    } catch (error: any) {
      console.error('[AI_ANALYZE_ERROR]', error)
      alert(`❌ AI Analyze Error\n\n${error?.message || 'Unknown error'}`)
    } finally {
      clearTimeout(timeout)
      setIsAnalyzing(false)
    }
  }
  
  const handlePlaceAiOrder = () => {
    if (!aiSuggestedPrice) return
    
    // Use existing scale-in modal with AI suggested price
    setScaleInPct(aiModalData?.size_hint_pct || 10)
    setShowAiModal(false)
    setShowScaleInModal(true)
  }
  
  // Helper functions
  const getAgeColor = (minutes: number) => {
    if (minutes < 5) return '#22c55e'
    if (minutes < 15) return '#eab308'
    if (minutes < 60) return '#f97316'
    return '#ef4444'
  }
  
  const formatAge = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }
  
  const calculateDistance = (from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 'N/A'
    return `${(((to - from) / from) * 100).toFixed(2)}%`
  }
  
  const calculateNewLevPct = (newPrice: number, currentEntry: number, lev: number) => {
    if (!Number.isFinite(newPrice) || !Number.isFinite(currentEntry) || currentEntry === 0) return 0
    // SHORT: profit when price goes DOWN
    const pct = ((currentEntry - newPrice) / currentEntry) * 100
    return pct * lev
  }
  
  // Debug logging removed to reduce console noise
  
  return (
    <div style={{
      background: '#0f172a',
      borderRadius: 8,
      overflow: 'hidden',
      width: '100%',
      maxWidth: 550
    }}>
      {/* Header with P&L Stats */}
      <div style={{
        padding: '12px 16px',
        background: '#0f172a',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{symbol}</h3>
          <button
            onClick={() => {
              console.log('[CLOSE_POSITION_CLICK]', { symbol, hasCallback: !!onClosePosition })
              if (!onClosePosition) {
                console.error('[CLOSE_POSITION_ERROR] No callback provided!')
                alert('ERROR: Close position callback not configured')
                return
              }
              try {
                onClosePosition(symbol)
              } catch (err) {
                console.error('[CLOSE_POSITION_CALLBACK_ERROR]', err)
                alert(`Error calling close position: ${err}`)
              }
            }}
            style={{
              background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
              color: '#fff',
              border: 'none',
              padding: '6px 12px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Close Position
          </button>
        </div>
        
        {/* P&L Metrics - Right Side */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 9, color: '#64748b' }}>P&L $</div>
            <div style={{
              fontSize: 18,
              fontWeight: 800,
              color: pnlUsd >= 0 ? '#10b981' : '#ef4444',
              textShadow: '0 1px 2px rgba(0,0,0,0.8)'
            }}>
              {pnlUsd >= 0 ? '+' : ''}{pnlUsd.toFixed(2)}
            </div>
          </div>
          
          <div>
            <div style={{ fontSize: 9, color: '#64748b' }}>P&L Lev %</div>
            <div style={{
              fontSize: 15,
              fontWeight: 800,
              color: pnlPctLev >= 0 ? '#10b981' : '#ef4444'
            }}>
              {pnlPctLev >= 0 ? '+' : ''}{pnlPctLev.toFixed(2)}%
            </div>
          </div>
          
          <div>
            <div style={{ fontSize: 9, color: '#64748b' }}>P&L %</div>
            <div style={{
              fontSize: 15,
              fontWeight: 800,
              color: pnlPct >= 0 ? '#10b981' : '#ef4444'
            }}>
              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
            </div>
          </div>
          
          <div>
            <div style={{ fontSize: 10, color: '#64748b' }}>AGE</div>
            <div style={{
              fontSize: 13,
              fontWeight: 700,
              color: getAgeColor(ageMinutes)
            }}>
              {formatAge(ageMinutes)}
            </div>
          </div>
        </div>
      </div>
      
      {/* Timeframe & Controls */}
      <div style={{
        padding: '8px 16px',
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        borderBottom: '1px solid #1e293b'
      }}>
        {(['1', '5', '15', '60'] as const).map(tf => (
          <button
            key={tf}
            onClick={() => {
              console.log('[TIMEFRAME_CHANGE] User clicked:', tf, 'current:', timeframe)
              setSeriesReady(false)  // Force chart re-initialization
              setTimeframe(tf)
            }}
            style={{
              background: timeframe === tf ? '#1e40af' : '#1e293b',
              color: timeframe === tf ? '#fff' : '#94a3b8',
              border: 'none',
              padding: '4px 12px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer'
            }}
          >
            {tf === '60' ? '1h' : `${tf}m`}
          </button>
        ))}
        
        <button
          onClick={() => {
            console.log('[MANUAL_REFRESH] User clicked R button')
            softUpdateLastCandle()  // 4️⃣ MANUAL REFRESH - soft update bez API callu
          }}
          style={{
            background: '#0b5dd7',
            color: '#fff',
            border: 'none',
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer'
          }}
          title="Manual refresh (soft update)"
        >
          R
        </button>
        
        <button
          onClick={() => setAutoUpdate(!autoUpdate)}
          style={{
            background: autoUpdate ? '#166534' : '#374151',
            color: '#fff',
            border: 'none',
            padding: '4px 12px',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer'
          }}
        >
          Auto: {autoUpdate ? 'ON' : 'OFF'}
        </button>
        
        <div style={{ marginLeft: 'auto', fontSize: 11, display: 'flex', gap: 12 }}>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>
            SL%: {slLevPct.toFixed(2)}%
          </span>
          <span style={{ color: '#10b981', fontWeight: 600 }}>
            TP%: {tpLevPct.toFixed(2)}%
          </span>
        </div>
      </div>
      
      {/* Chart Container */}
      <div ref={containerRef} style={{ width: '100%', height: 363, position: 'relative' }}>
        {chartError && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#1e293b',
            color: '#ef4444',
            padding: 20,
            textAlign: 'center'
          }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>⚠️ Chart Error</div>
              <div style={{ fontSize: 12 }}>{chartError}</div>
            </div>
          </div>
        )}
      </div>
      
      {/* EMA Legend */}
      <div style={{
        padding: '6px 12px',
        borderTop: '1px solid #1e293b',
        fontSize: 11,
        color: '#94a3b8',
        display: 'flex',
        gap: 16
      }}>
        <span><span style={{ color: '#60a5fa' }}>━</span> EMA 20</span>
        <span><span style={{ color: '#f97316' }}>━</span> EMA 50</span>
        <span><span style={{ color: '#a78bfa' }}>━</span> EMA 100</span>
      </div>
      
      {/* AI Action Buttons */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid #1e293b',
        display: 'flex',
        gap: 12,
        alignItems: 'center'
      }}>
        <button
          onClick={handleAnalyzeClick}
          disabled={isAnalyzing}
          style={{
            flex: 1,
            background: isAnalyzing 
              ? '#6b7280' 
              : 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
            color: '#fff',
            border: 'none',
            padding: '10px 16px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: isAnalyzing ? 'not-allowed' : 'pointer',
            opacity: isAnalyzing ? 0.6 : 1,
            boxShadow: '0 2px 6px rgba(139, 92, 246, 0.3)'
          }}
          title="AI Analyze Entry - GPT-4o analyzes optimal SHORT entry point"
        >
          {isAnalyzing ? '⏳ Analyzing...' : '🧠 AI Analyze Entry'}
        </button>
        
        <button
          onClick={handleProfitTakerClick}
          disabled={isProfitTakerRunning}
          style={{
            flex: 1,
            background: isProfitTakerRunning 
              ? 'linear-gradient(135deg, #6b7280 0%, #4b5563 100%)' 
              : 'linear-gradient(135deg, #ec4899 0%, #db2777 100%)',
            color: '#fff',
            border: 'none',
            padding: '10px 16px',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: isProfitTakerRunning ? 'not-allowed' : 'pointer',
            opacity: isProfitTakerRunning ? 0.7 : 1,
            boxShadow: isProfitTakerRunning 
              ? '0 2px 4px rgba(107, 114, 128, 0.2)' 
              : '0 2px 6px rgba(236, 72, 153, 0.3)',
            transition: 'all 0.2s ease',
            position: 'relative',
            overflow: 'hidden'
          }}
          title="AI Profit Taker - Inteligentní úprava SL/TP na základě market analýzy"
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6
          }}>
            {isProfitTakerRunning ? (
              <>
                <span style={{ 
                  display: 'inline-block',
                  animation: 'spin 1s linear infinite'
                }}>⚙️</span>
                <span>Analyzuji...</span>
              </>
            ) : (
              <>
                <span>💰</span>
                <span>AI Profit Taker</span>
              </>
            )}
          </span>
        </button>
      </div>
      
      {/* Scale-In Buttons */}
      <div style={{
        padding: '8px 16px',
        borderTop: '1px solid #1e293b',
        display: 'flex',
        gap: 8,
        alignItems: 'center'
      }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>Scale-In:</span>
        {[5, 10, 20, 50].map(pct => (
          <button
            key={pct}
            onClick={() => {
              setScaleInPct(pct)
              setShowScaleInModal(true)
            }}
            style={{
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              color: '#fff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              boxShadow: '0 2px 4px rgba(16, 185, 129, 0.2)'
            }}
          >
            {pct}%
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#64748b' }}>
          Free: ${availableBalance.toFixed(0)}
        </span>
      </div>
      
      {/* Loading/Error */}
      {loading && klines.length === 0 && (
        <div style={{ 
          padding: 24, 
          textAlign: 'center', 
          fontSize: 14, 
          color: '#94a3b8',
          background: '#1e293b',
          borderRadius: 8,
          margin: 12
        }}>
          <div style={{ marginBottom: 8 }}>⏳ Loading chart data...</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{symbol} • {interval}</div>
        </div>
      )}
      {error && (
        <div style={{ 
          padding: 24, 
          textAlign: 'center', 
          fontSize: 14, 
          color: '#ef4444',
          background: '#1e293b',
          borderRadius: 8,
          margin: 12
        }}>
          <div style={{ marginBottom: 8 }}>❌ Error loading chart</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>{error}</div>
          <button 
            onClick={refetch}
            style={{
              marginTop: 12,
              padding: '6px 12px',
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer'
            }}
          >
            Retry
          </button>
        </div>
      )}
      
      {/* TP Confirm Modal */}
      {showTpModal && draggedTpPrice && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: '#1e293b',
            padding: 24,
            borderRadius: 8,
            minWidth: 400,
            border: '1px solid #334155'
          }}>
            <h3 style={{ margin: '0 0 16px 0' }}>Confirm TP Change</h3>
            <div style={{ marginBottom: 12 }}>Symbol: <strong>{symbol}</strong></div>
            <div style={{ marginBottom: 12 }}>New TP: <strong>{draggedTpPrice.toFixed(5)}</strong></div>
            <div style={{ marginBottom: 12 }}>
              TP Lev %: <strong style={{ color: '#10b981' }}>
                {calculateNewLevPct(draggedTpPrice, entryPrice, leverage).toFixed(2)}%
              </strong>
            </div>
            <div style={{ marginBottom: 16 }}>
              Distance from Entry: <strong>{calculateDistance(entryPrice, draggedTpPrice)}</strong>
            </div>
            
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleConfirmTp}
                style={{
                  flex: 1,
                  background: '#10b981',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Confirm
              </button>
              <button
                onClick={handleCancelTp}
                style={{
                  flex: 1,
                  background: '#374151',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* SL Confirm Modal */}
      {showSlModal && draggedSlPrice && (
        <>
          {/* Semi-transparent backdrop */}
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9998
          }} onClick={handleCancelSl} />
          
          {/* Side panel */}
          <div style={{
            position: 'fixed',
            top: 120,
            right: 20,
            width: 320,
            background: '#1e293b',
            padding: 16,
            borderRadius: 8,
            border: '1px solid #334155',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            zIndex: 9999
          }}>
            <h3 style={{ margin: '0 0 16px 0' }}>Confirm SL Change</h3>
            <div style={{ marginBottom: 12 }}>Symbol: <strong>{symbol}</strong></div>
            <div style={{ marginBottom: 12 }}>New SL: <strong>{draggedSlPrice.toFixed(5)}</strong></div>
            <div style={{ marginBottom: 12 }}>
              SL Lev %: <strong style={{ color: '#ef4444' }}>
                {calculateNewLevPct(draggedSlPrice, entryPrice, leverage).toFixed(2)}%
              </strong>
            </div>
            <div style={{ marginBottom: 16 }}>
              Distance from Entry: <strong>{calculateDistance(entryPrice, draggedSlPrice)}</strong>
            </div>
            
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleConfirmSl}
                style={{
                  flex: 1,
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Confirm
              </button>
              <button
                onClick={handleCancelSl}
                style={{
                  flex: 1,
                  background: '#374151',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      
      {/* Scale-In Modal */}
      {showScaleInModal && (
        <>
          {/* Semi-transparent backdrop */}
          <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9998
          }} onClick={() => setShowScaleInModal(false)} />
          
          {/* Side panel */}
          <div style={{
            position: 'fixed',
            top: 120,
            right: 20,
            width: 320,
            background: '#1e293b',
            padding: 16,
            borderRadius: 8,
            border: '1px solid #334155',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            zIndex: 9999
          }}>
            <h3 style={{ margin: '0 0 16px 0' }}>Scale-In {scaleInPct}%</h3>
            <div style={{ marginBottom: 12 }}>Symbol: <strong>{symbol}</strong></div>
            <div style={{ marginBottom: 12 }}>Current Position: <strong>${positionSizeUsd.toFixed(2)}</strong></div>
            <div style={{ marginBottom: 12 }}>
              Additional Amount: <strong>${(positionSizeUsd * scaleInPct / 100).toFixed(2)}</strong>
            </div>
            <div style={{ marginBottom: 16 }}>
              New Total: <strong>${(positionSizeUsd * (1 + scaleInPct / 100)).toFixed(2)}</strong>
            </div>
            
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => {
                  alert('Scale-In feature coming soon!')
                  setShowScaleInModal(false)
                }}
                style={{
                  flex: 1,
                  background: '#10b981',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Confirm
              </button>
              <button
                onClick={() => setShowScaleInModal(false)}
                style={{
                  flex: 1,
                  background: '#374151',
                  color: '#fff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 4,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      
      {/* AI Analyze Entry Modal */}
      {showAiModal && aiModalData && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: '#1e293b',
            padding: 24,
            borderRadius: 8,
            minWidth: 500,
            maxWidth: 700,
            border: '1px solid #334155',
            maxHeight: '80vh',
            overflow: 'auto'
          }}>
            <h3 style={{ margin: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              {aiModalData.decision === 'entry' ? '✅ AI Entry Suggested' : '⏭️ AI Skip'}
            </h3>
            
            <div style={{ 
              marginBottom: 16,
              padding: 12,
              background: '#0f172a',
              borderRadius: 6,
              fontSize: 13
            }}>
              <div style={{ marginBottom: 8 }}>
                <strong>Symbol:</strong> {symbol}
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Mode:</strong> <span style={{ color: '#8b5cf6' }}>{aiModalData.mode}</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Class:</strong> <span style={{ color: aiModalData.class === 'scout' ? '#f59e0b' : '#10b981' }}>
                  {aiModalData.class}
                </span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Confidence:</strong> {' '}
                <span style={{ 
                  color: aiModalData.confidence >= 0.75 ? '#10b981' : aiModalData.confidence >= 0.60 ? '#f59e0b' : '#ef4444',
                  fontWeight: 700
                }}>
                  {(aiModalData.confidence * 100).toFixed(1)}%
                </span>
              </div>
              {aiModalData.entry && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <strong>Entry Price:</strong> {' '}
                    <span style={{ color: '#8b5cf6', fontWeight: 700, fontSize: 16 }}>
                      {aiModalData.entry.price.toFixed(5)}
                    </span>
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <strong>Size Hint:</strong> <span style={{ color: '#10b981' }}>{aiModalData.size_hint_pct}%</span>
                  </div>
                </>
              )}
            </div>
            
            <div style={{ 
              background: '#0f172a', 
              padding: 16,
              borderRadius: 6,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.6,
              marginBottom: 16,
              maxHeight: '300px',
              overflow: 'auto'
            }}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: '#94a3b8' }}>📋 Reasoning:</div>
              {aiModalData.reasoning}
            </div>
            
            {aiModalData.diagnostics && (
              <div style={{ 
                background: '#0f172a', 
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                marginBottom: 16
              }}>
                <div style={{ fontWeight: 600, marginBottom: 6, color: '#94a3b8' }}>🔍 Diagnostics:</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div>Edge (bps): <span style={{ color: '#8b5cf6' }}>{aiModalData.diagnostics.edge_from_current_bps?.toFixed(2)}</span></div>
                  <div>Min Required: <span style={{ color: '#f59e0b' }}>{aiModalData.diagnostics.edge_min_required_bps}</span></div>
                  {aiModalData.diagnostics.dist_to_vwap_bps !== null && (
                    <div>VWAP Dist: {aiModalData.diagnostics.dist_to_vwap_bps?.toFixed(2)} bps</div>
                  )}
                  {aiModalData.diagnostics.dist_to_ema50_m15_bps !== null && (
                    <div>EMA50 Dist: {aiModalData.diagnostics.dist_to_ema50_m15_bps?.toFixed(2)} bps</div>
                  )}
                </div>
              </div>
            )}
            
            <div style={{ display: 'flex', gap: 12 }}>
              {aiModalData.decision === 'entry' && aiModalData.entry && (
                <button
                  onClick={handlePlaceAiOrder}
                  style={{
                    flex: 1,
                    background: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
                    color: '#fff',
                    border: 'none',
                    padding: '10px 16px',
                    borderRadius: 6,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontSize: 14
                  }}
                >
                  📊 Place Order
                </button>
              )}
              <button
                onClick={() => setShowAiModal(false)}
                style={{
                  flex: 1,
                  background: '#374151',
                  color: '#fff',
                  border: 'none',
                  padding: '10px 16px',
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* AI Profit Taker Modal - napravo u grafu */}
      {showProfitTakerModal && profitTakerResult && (
        <div style={{
          position: 'fixed',
          top: 120,
          right: 20,
          width: 320,
          background: '#1e293b',
          padding: 16,
          borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          border: '1px solid #334155',
          zIndex: 9999,
          maxHeight: 'calc(100vh - 140px)',
          overflowY: 'auto'
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginBottom: 16
          }}>
            <h3 style={{ 
              margin: 0, 
              display: 'flex', 
              alignItems: 'center', 
              gap: 8
            }}>
              {profitTakerResult.success ? (
                profitTakerResult.action === 'adjust_exits' ? '✅ SL/TP Upraveny' : '⏭️ Ponecháno'
              ) : (
                '❌ Chyba'
              )}
            </h3>
            <button
              onClick={() => {
                setShowProfitTakerModal(false)
                setProfitTakerResult(null)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                fontSize: 20,
                cursor: 'pointer',
                padding: 0,
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              ✕
            </button>
          </div>
          
          {profitTakerResult.success && profitTakerResult.decision && (
            <>
              <div style={{
                marginBottom: 16,
                padding: 12,
                background: '#0f172a',
                borderRadius: 6,
                fontSize: 13
              }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>Symbol:</strong> {profitTakerResult.symbol}
                </div>
                {profitTakerResult.action === 'adjust_exits' && (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Nový SL:</strong> {' '}
                      <span style={{ color: '#ef4444', fontWeight: 700 }}>
                        {profitTakerResult.decision.new_sl !== null 
                          ? profitTakerResult.decision.new_sl.toFixed(4)
                          : 'nezměněn'}
                      </span>
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      <strong>Nový TP:</strong> {' '}
                      <span style={{ color: '#10b981', fontWeight: 700 }}>
                        {profitTakerResult.decision.new_tp !== null
                          ? profitTakerResult.decision.new_tp.toFixed(4)
                          : 'nezměněn'}
                      </span>
                    </div>
                  </>
                )}
                <div style={{ marginBottom: 8 }}>
                  <strong>Confidence:</strong> {' '}
                  <span style={{
                    color: profitTakerResult.decision.confidence >= 0.75 ? '#10b981' : 
                           profitTakerResult.decision.confidence >= 0.50 ? '#f59e0b' : '#ef4444',
                    fontWeight: 700
                  }}>
                    {Math.round((profitTakerResult.decision.confidence || 0) * 100)}%
                  </span>
                </div>
              </div>
              
              <div style={{
                background: '#0f172a',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                lineHeight: 1.6,
                marginBottom: 12,
                maxHeight: 200,
                overflow: 'auto'
              }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: '#94a3b8' }}>
                  📋 Zdůvodnění:
                </div>
                {profitTakerResult.decision.rationale}
              </div>
            </>
          )}
          
          {!profitTakerResult.success && (
            <div style={{
              padding: 12,
              background: '#991b1b',
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 12
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {profitTakerResult.code && `Kód: ${profitTakerResult.code}`}
              </div>
              {profitTakerResult.error}
            </div>
          )}
          
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 11,
            opacity: 0.7
          }}>
            <span>Latency: {profitTakerResult.latency}ms</span>
            <button
              onClick={() => {
                setShowProfitTakerModal(false)
                setProfitTakerResult(null)
              }}
              style={{
                background: '#475569',
                color: '#e2e8f0',
                border: 'none',
                padding: '6px 12px',
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Zavřít
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// CRITICAL: Memoization to prevent unnecessary re-renders, but allow price updates
export const TradingViewChart = React.memo(TradingViewChartComponent, (prevProps, nextProps) => {
  // Re-render only when critical props change
  const symbolSame = prevProps.symbol === nextProps.symbol
  const priceSame = prevProps.currentPrice === nextProps.currentPrice
  const slSame = prevProps.slPrice === nextProps.slPrice
  const tpSame = prevProps.tpPrice === nextProps.tpPrice
  
  // Return TRUE = skip re-render, FALSE = do re-render
  const shouldSkip = symbolSame && priceSame && slSame && tpSame
  
  if (!shouldSkip) {
    console.log('[MEMO] Allowing re-render:', {
      symbol: nextProps.symbol,
      symbolChanged: !symbolSame,
      priceChanged: !priceSame,
      slChanged: !slSame,
      tpChanged: !tpSame
    })
  }
  
  return shouldSkip
})

