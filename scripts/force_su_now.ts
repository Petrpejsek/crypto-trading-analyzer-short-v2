import path from 'node:path'
import dotenv from 'dotenv'

async function main(): Promise<void> {
  // Load env like server does
  try {
    const tryLoad = (p: string) => { try { dotenv.config({ path: p }) } catch {} }
    tryLoad(path.resolve(process.cwd(), '.env.local'))
    tryLoad(path.resolve(process.cwd(), '.env'))
  } catch {}

  const symbol = 'BTCUSDT_260327'
  
  console.log('[FORCE_SU] Starting for', symbol)
  
  try {
    // Import SU modules
    const { getStrategyUpdaterList, forceDueNow } = await import('../services/strategy-updater/registry')
    const { processDueStrategyUpdates } = await import('../services/strategy-updater/trigger')
    
    // Check current entries
    const entries = getStrategyUpdaterList()
    console.log('[FORCE_SU] Current entries:', entries.length)
    
    const entry = entries.find(e => e.symbol === symbol)
    if (!entry) {
      console.log('[FORCE_SU] No entry found for', symbol)
      return
    }
    
    console.log('[FORCE_SU] Found entry:', {
      symbol: entry.symbol,
      side: entry.side,
      triggerAt: entry.triggerAt,
      status: entry.status
    })
    
    // Force due now
    const forced = forceDueNow(symbol)
    console.log('[FORCE_SU] Force due result:', forced)
    
    // Process due updates
    console.log('[FORCE_SU] Processing due updates...')
    await processDueStrategyUpdates()
    console.log('[FORCE_SU] Done')
    
  } catch (e: any) {
    console.error('[FORCE_SU] Error:', e?.message || e)
  }
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })
