// Utility functions for Reactive Entry (SHORT trading)

/**
 * Round price to valid tick size
 */
export function roundToTick(price: number, tickSize: number): number {
  if (!tickSize || tickSize <= 0) return price
  
  const decimals = String(tickSize).includes('.') 
    ? String(tickSize).split('.')[1].length 
    : 0
  
  return Number((Math.floor(price / tickSize) * tickSize).toFixed(decimals))
}

/**
 * Calculate edge from current price in basis points (SHORT: entry - current)
 */
export function edgeFromCurrentBps(entryPrice: number, currentPrice: number): number {
  if (!entryPrice || !currentPrice || currentPrice <= 0) return 0
  
  // SHORT: Chceme entry >= current, edge = (entry - current) / current × 10000
  return ((entryPrice - currentPrice) / currentPrice) * 10000
}

/**
 * Find nearest fresh resistance (age <= maxAgeMins)
 */
export function findNearestResistance(
  resistances: Array<{ price: number; age_mins: number }>,
  currentPrice: number,
  maxAgeMins: number = 30
): { price: number; age_mins: number } | null {
  if (!Array.isArray(resistances) || resistances.length === 0) return null
  
  // Filter: age <= maxAgeMins AND price >= current (resistance musí být nad současnou cenou)
  const validResistances = resistances.filter(
    r => r.age_mins <= maxAgeMins && r.price >= currentPrice
  )
  
  if (validResistances.length === 0) return null
  
  // Najdi nejbližší (minimální distance)
  return validResistances.reduce((nearest, r) => 
    Math.abs(r.price - currentPrice) < Math.abs(nearest.price - currentPrice) 
      ? r 
      : nearest
  )
}

/**
 * Round number to N decimal places
 */
export function round(n: number, decimals: number = 6): number {
  const factor = Math.pow(10, decimals)
  return Math.round(n * factor) / factor
}

