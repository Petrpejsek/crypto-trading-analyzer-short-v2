// EMA (Exponential Moving Average) calculation
export function calculateEMA(prices: number[], period: number): (number | null)[] {
  if (prices.length < period) {
    return prices.map(() => null)
  }
  
  const multiplier = 2 / (period + 1)
  const result: (number | null)[] = []
  
  // 1. Calculate first SMA (Simple Moving Average)
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  
  // 2. Fill nulls for initial values
  for (let i = 0; i < period - 1; i++) {
    result.push(null)
  }
  result.push(ema)
  
  // 3. Calculate EMA for remaining values
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema
    result.push(ema)
  }
  
  return result
}

