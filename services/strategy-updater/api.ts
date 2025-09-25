import { getStrategyUpdaterList, StrategyUpdaterEntry } from './registry'

// API handler for strategy updater status
export async function getStrategyUpdaterStatus(symbol?: string): Promise<{
  enabled: boolean
  entries: StrategyUpdaterEntry[]
}> {
  try {
    // Check if strategy updater is enabled
    const enabled = process.env.STRATEGY_UPDATER_ENABLED === '1' || process.env.STRATEGY_UPDATER_ENABLED === 'true'
    
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
      const isInternal = /^e_l_/.test(clientId)
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

