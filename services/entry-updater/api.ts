import { listEntryOrders } from './registry'

export async function getEntryUpdaterStatus(symbol?: string): Promise<{ enabled: boolean; entries: any[] }> {
  try {
    const enabledEnv = String(process.env.ENTRY_UPDATER_ENABLED || '').toLowerCase()
    const enabled = !(enabledEnv === '0' || enabledEnv === 'false' || enabledEnv === 'off')
    const all = listEntryOrders()
    // Only show tracks for orders that are still open (active)
    const entries = symbol ? all.filter(e => e.symbol === symbol) : all
    return { enabled, entries }
  } catch {
    return { enabled: false, entries: [] }
  }
}


