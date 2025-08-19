/**
 * OPRAVA CHYBY #1: Konzistentní výpočetní funkce pro finanční metriky
 * 
 * Tento soubor obsahuje standardizované funkce pro výpočty změn procent
 * a dalších finančních metrik napříč celou aplikací.
 */

export type KlineData = {
  close: number
  open?: number
  high?: number
  low?: number
  openTime?: string
  closeTime?: string
}

/**
 * Standardní výpočet změny v procentech mezi dvěma hodnotami
 * 
 * @param current - Aktuální hodnota
 * @param previous - Předchozí hodnota 
 * @returns Změna v procentech nebo null při chybě/nevalidních datech
 */
export function calculateChangePercent(current: number, previous: number): number | null {
  try {
    // Validace vstupních dat
    if (!Number.isFinite(current) || !Number.isFinite(previous)) {
      return null
    }
    
    // Prevence dělení nulou nebo zápornými čísly
    if (previous <= 0) {
      return null
    }
    
    // Standardní výpočet: ((current / previous) - 1) * 100
    const changePercent = ((current / previous) - 1) * 100
    
    // Validace výsledku
    if (!Number.isFinite(changePercent)) {
      return null
    }
    
    return changePercent
  } catch {
    return null
  }
}

/**
 * Výpočet změny mezi posledními dvěma klines
 * 
 * @param klines - Array kline dat
 * @param windowSize - Počet posledních klines k použití (default 2)
 * @returns Změna v procentech nebo null
 */
export function calculateKlineChangePercent(
  klines: KlineData[], 
  windowSize: number = 2
): number | null {
  try {
    // Validace vstupních dat
    if (!Array.isArray(klines) || klines.length < windowSize) {
      return null
    }
    
    // Získání posledních N klines
    const slice = klines.slice(-windowSize)
    const previous = Number(slice[slice.length - 2]?.close)
    const current = Number(slice[slice.length - 1]?.close)
    
    return calculateChangePercent(current, previous)
  } catch {
    return null
  }
}

/**
 * Výpočet H1 regime pro BTC/ETH
 * 
 * @param h1Klines - Array H1 kline dat
 * @returns Objekt s regime informacemi
 */
export function calculateRegime(h1Klines: KlineData[]): {
  h1_change_pct: number | null
  current_close: number | null
  previous_close: number | null
} {
  try {
    if (!Array.isArray(h1Klines) || h1Klines.length < 2) {
      return {
        h1_change_pct: null,
        current_close: null,
        previous_close: null
      }
    }
    
    const current = Number(h1Klines[h1Klines.length - 1]?.close)
    const previous = Number(h1Klines[h1Klines.length - 2]?.close)
    
    return {
      h1_change_pct: calculateChangePercent(current, previous),
      current_close: Number.isFinite(current) ? current : null,
      previous_close: Number.isFinite(previous) ? previous : null
    }
  } catch {
    return {
      h1_change_pct: null,
      current_close: null,
      previous_close: null
    }
  }
}

/**
 * Validace velikosti JSON dat před clipboard operacemi
 * 
 * @param data - Data k validaci
 * @param maxSizeKB - Maximální velikost v KB (default 1024 = 1MB)
 * @returns true pokud je velikost OK, jinak false
 */
export function validateDataSize(data: any, maxSizeKB: number = 1024): {
  isValid: boolean
  sizeKB: number
  error?: string
} {
  try {
    const jsonString = JSON.stringify(data)
    const sizeKB = new Blob([jsonString]).size / 1024
    
    if (sizeKB > maxSizeKB) {
      return {
        isValid: false,
        sizeKB,
        error: `Data size ${sizeKB.toFixed(0)}KB exceeds limit ${maxSizeKB}KB`
      }
    }
    
    return {
      isValid: true,
      sizeKB
    }
  } catch (error: any) {
    return {
      isValid: false,
      sizeKB: 0,
      error: error?.message || 'Validation failed'
    }
  }
}

/**
 * Bezpečný výpočet průměru s validací
 * 
 * @param values - Array číselných hodnot
 * @returns Průměr nebo null při chybě
 */
export function calculateSafeAverage(values: (number | null)[]): number | null {
  try {
    const validValues = values.filter(v => Number.isFinite(v)) as number[]
    
    if (validValues.length === 0) {
      return null
    }
    
    const sum = validValues.reduce((acc, val) => acc + val, 0)
    const average = sum / validValues.length
    
    return Number.isFinite(average) ? average : null
  } catch {
    return null
  }
}
