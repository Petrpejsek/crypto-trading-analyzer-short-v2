import { useState, useEffect, useCallback, useRef } from 'react'

export type Kline = {
  openTime: number
  open: string
  high: string
  low: string
  close: string
  volume: string
  closeTime: number
}

export function useKlinesBatch(
  symbols: string[],
  interval: string,
  limit: number
) {
  const [data, setData] = useState<Record<string, Kline[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  
  // CRITICAL FIX: Use ref to store symbols to prevent infinite loop
  // Array reference changes on every render → infinite dependency trigger
  const symbolsRef = useRef<string[]>([])
  const symbolsKey = symbols.join(',')
  
  const fetchData = useCallback(async () => {
    const currentSymbols = symbolsRef.current
    if (currentSymbols.length === 0) return
    
    setLoading(true)
    setError(null)
    
    try {
      const res = await fetch('/api/klines_batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: currentSymbols, interval, limit })
      })
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      
      const json = await res.json()
      
      if (!json.ok) {
        throw new Error(json.error || 'Unknown error')
      }
      
      // Extract klines from results
      const newData: Record<string, Kline[]> = {}
      for (const symbol of currentSymbols) {
        if (json.results[symbol]?.ok && json.results[symbol]?.klines) {
          newData[symbol] = json.results[symbol].klines
        }
      }
      
      console.log('[KLINES_BATCH] Received data from API:', {
        symbols: currentSymbols,
        results: Object.keys(newData),
        counts: Object.fromEntries(Object.entries(newData).map(([k, v]) => [k, v.length]))
      })
      
      // 🔥 CRITICAL FIX: Only update state if data actually changed
      // Compare with current data to prevent unnecessary re-renders
      setData(prevData => {
        console.log('[KLINES_BATCH] Comparing data...', {
          prevKeys: Object.keys(prevData),
          newKeys: Object.keys(newData)
        })
        
        // If no previous data OR newData is empty, always update (first load)
        if (Object.keys(prevData).length === 0) {
          console.log('[KLINES_BATCH] ✅ First load - updating data', {
            newDataKeys: Object.keys(newData),
            isEmpty: Object.keys(newData).length === 0
          })
          return newData
        }
        
        let hasChanges = false
        
        // Check if symbols changed
        const prevSymbols = Object.keys(prevData)
        const newSymbols = Object.keys(newData)
        if (prevSymbols.length !== newSymbols.length) {
          console.log('[KLINES_BATCH] Symbols count changed, updating...')
          hasChanges = true
        }
        
        // Check if any symbol's data changed
        if (!hasChanges) {
          for (const sym of newSymbols) {
            const prevKlines = prevData[sym]
            const newKlines = newData[sym]
            
            if (!newKlines || newKlines.length === 0) {
              console.warn('[KLINES_BATCH] Empty klines for symbol:', sym)
              continue
            }
            
            // Quick check: compare length and first/last timestamps
            if (!prevKlines || 
                prevKlines.length !== newKlines.length ||
                prevKlines[0]?.openTime !== newKlines[0]?.openTime ||
                prevKlines[prevKlines.length - 1]?.openTime !== newKlines[newKlines.length - 1]?.openTime) {
              console.log('[KLINES_BATCH] Data changed for', sym, {
                prevLen: prevKlines?.length || 0,
                newLen: newKlines.length,
                prevFirst: prevKlines?.[0]?.openTime,
                newFirst: newKlines[0]?.openTime,
                prevLast: prevKlines?.[prevKlines.length - 1]?.openTime,
                newLast: newKlines[newKlines.length - 1]?.openTime
              })
              hasChanges = true
              break
            }
          }
        }
        
        if (hasChanges) {
          console.log('[KLINES_BATCH] ✅ Updating data (changes detected)')
          return newData
        } else {
          console.log('[KLINES_BATCH] ⏭️ Skipping update (data unchanged)')
          return prevData  // Return SAME reference to prevent re-renders
        }
      })
    } catch (e: any) {
      setError(e?.message || 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [interval, limit]) // FIXED: symbols removed from dependencies
  
  // Update ref when symbols change
  useEffect(() => {
    symbolsRef.current = symbols
  }, [symbolsKey]) // Use string key instead of array reference
  
  // Fetch data when dependencies change
  useEffect(() => {
    fetchData()
  }, [symbolsKey, interval, limit, fetchData])
  
  return { data, loading, error, refetch: fetchData }
}

