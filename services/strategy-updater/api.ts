import { getStrategyUpdaterList, StrategyUpdaterEntry } from './registry'

// API handler for strategy updater status
export async function getStrategyUpdaterStatus(symbol?: string): Promise<{
  enabled: boolean
  entries: StrategyUpdaterEntry[]
}> {
  try {
    // Check if strategy updater is enabled (same gate as trigger)
    let enabled = true
    try {
      const { isStrategyUpdaterEnabled } = await import('./trigger')
      enabled = isStrategyUpdaterEnabled()
    } catch {}
    
    // Get all entries
    const allEntries = getStrategyUpdaterList()
    
    // Filter by symbol if provided
    const entries = symbol 
      ? allEntries.filter(entry => entry.symbol === symbol)
      : allEntries

    return {
      enabled,
      entries
    }
  } catch (error) {
    console.error('[STRATEGY_UPDATER_API_ERR]', error)
    return {
      enabled: false,
      entries: []
    }
  }
}

// Check if a symbol has internal entry orders
export async function hasInternalEntryOrders(symbol: string, orders: any[]): Promise<boolean> {
  try {
    // Check for internal entry orders (e_l_ prefix) for this symbol
    const hasInternal = orders.some((order: any) => {
      const clientId = String(order?.clientOrderId || '')
      const isInternal = /^sv2_e_l_/.test(clientId)
      const isEntry = String(order?.side) === 'BUY' && 
                     String(order?.type) === 'LIMIT' && 
                     !(order?.reduceOnly || order?.closePosition)
      return isInternal && isEntry && String(order?.symbol) === symbol
    })

    return hasInternal
  } catch (error) {
    console.error('[HAS_INTERNAL_ENTRY_ERR]', { symbol, error })
    return false
  }
}

