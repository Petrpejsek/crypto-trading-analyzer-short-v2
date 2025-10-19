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
      
      setData(newData)
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

