import tradingCfg from '../../config/trading.json'

/**
 * Zaokrouhlí cenu na nejbližší tickSize (minimální cenový krok na Binance)
 */
function roundToTickSize(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price
  return Math.round(price / tickSize) * tickSize
}

/**
 * Vypočítá počet desetinných míst z tickSize
 */
function getPrecisionFromTickSize(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 8 // default
  const str = tickSize.toFixed(20) // Convert to string with high precision
  const match = str.match(/\.(\d*[1-9])?/)
  return match && match[1] ? match[1].length : 0
}

/**
 * Aplikuje ENTRY_PRICE_MULTIPLIER na entry cenu.
 * Pro SHORT: vyšší multiplier = vyšší entry cena = lepší entry (prodáváš dráž).
 * 
 * @param entryPrice - Původní entry cena z AI asistenta nebo risk managementu
 * @param tickSize - Optional: minimální cenový krok pro zaokrouhlení výsledku
 * @param pricePrecision - Optional: maximální počet desetinných míst (override auto-detect z tickSize)
 * @returns Upravená entry cena (zaokrouhlená na tickSize + precision pokud jsou poskytnuty)
 * 
 * Bezpečnostní kontroly:
 * - Multiplier musí být v rozsahu 95.0 - 105.0 (max ±5%)
 * - Pokud hodnota chybí nebo je mimo rozsah, použije se 100.0 (bez úpravy)
 * - NIKDY se neaplikuje na SL nebo TP
 * - Výsledek se automaticky zaokrouhlí na tickSize + precision pokud jsou poskytnuty
 */
export function applyEntryMultiplier(entryPrice: number, tickSize?: number, pricePrecision?: number): number {
  // Validace vstupu
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    console.warn('[ENTRY_ADJUSTER] Invalid entry price, skipping adjustment:', entryPrice)
    return entryPrice
  }

  // Načtení multiplieru z configu
  const multiplier = Number((tradingCfg as any)?.ENTRY_PRICE_MULTIPLIER)
  
  // Validace multiplieru - musí být v rozsahu 95.0 - 105.0
  const MIN_MULTIPLIER = 95.0
  const MAX_MULTIPLIER = 105.0
  
  if (!Number.isFinite(multiplier) || multiplier < MIN_MULTIPLIER || multiplier > MAX_MULTIPLIER) {
    // Fallback na 100% pokud hodnota chybí nebo je mimo rozsah
    if (Number.isFinite(multiplier)) {
      console.warn(`[ENTRY_ADJUSTER] Multiplier ${multiplier}% out of range [${MIN_MULTIPLIER}, ${MAX_MULTIPLIER}], using 100%`)
    }
    return entryPrice
  }

  // Pokud je multiplier 100.0, není potřeba nic počítat
  if (multiplier === 100.0) {
    return entryPrice
  }

  // Aplikace multiplieru
  let adjustedPrice = entryPrice * (multiplier / 100.0)
  
  // Zaokrouhlení na tickSize pokud je poskytnut
  if (tickSize !== undefined && Number.isFinite(tickSize) && tickSize > 0) {
    adjustedPrice = roundToTickSize(adjustedPrice, tickSize)
  }
  
  // Aplikace precision (počet desetinných míst)
  let finalPrecision: number | undefined = undefined
  if (pricePrecision !== undefined && Number.isFinite(pricePrecision) && pricePrecision >= 0) {
    // Explicitně poskytnutá precision
    finalPrecision = Math.floor(pricePrecision)
  } else if (tickSize !== undefined && Number.isFinite(tickSize) && tickSize > 0) {
    // Auto-detect z tickSize
    finalPrecision = getPrecisionFromTickSize(tickSize)
  }
  
  if (finalPrecision !== undefined) {
    // Zaokrouhli na správný počet desetinných míst
    adjustedPrice = Number(adjustedPrice.toFixed(finalPrecision))
  }
  
  // Logování každé úpravy
  console.info('[ENTRY_ADJUSTED]', {
    original: entryPrice,
    multiplier: `${multiplier}%`,
    final: adjustedPrice,
    change: adjustedPrice - entryPrice,
    changePercent: `${((adjustedPrice / entryPrice - 1) * 100).toFixed(3)}%`,
    tickSize: tickSize || 'not_provided',
    precision: finalPrecision !== undefined ? finalPrecision : 'not_applied'
  })
  
  return adjustedPrice
}

