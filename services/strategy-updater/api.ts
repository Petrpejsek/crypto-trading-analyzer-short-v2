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
    
    // Get in-memory entries
    const memEntries = getStrategyUpdaterList()
    // Merge with persisted registry on disk (source of truth across module reloads)
    let diskEntries: StrategyUpdaterEntry[] = []
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const file = path.resolve(process.cwd(), 'runtime/strategy_updater.json')
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        const arr: any[] = Array.isArray(parsed?.entries) ? parsed.entries : []
        diskEntries = arr.filter(e => e && typeof e.symbol === 'string') as StrategyUpdaterEntry[]
      }
    } catch {}
    // Union by symbol; prefer in-memory (latest), otherwise take disk
    const bySymbol: Record<string, StrategyUpdaterEntry> = {}
    for (const e of diskEntries) { bySymbol[e.symbol] = e }
    for (const e of memEntries) { bySymbol[e.symbol] = e }
    const allEntries = Object.values(bySymbol)
    
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

