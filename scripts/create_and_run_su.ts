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
  
  console.log('[CREATE_SU] Starting for', symbol)
  
  try {
    // Import SU modules
    const { scheduleStrategyUpdate, forceDueNow } = await import('../services/strategy-updater/registry')
    const { processDueStrategyUpdates } = await import('../services/strategy-updater/trigger')
    
    // Create new SU entry
    console.log('[CREATE_SU] Creating new SU entry...')
    scheduleStrategyUpdate(
      symbol,
      'SHORT',
      113325.7,
      0.001,
      null, // NO hardcoded SL - let AI decide everything
      115476.5,
      { initialDelayMs: 0 } // Immediate
    )
    
    // Force due now
    console.log('[CREATE_SU] Forcing due now...')
    const forced = forceDueNow(symbol)
    console.log('[CREATE_SU] Force due result:', forced)
    
    // Process due updates
    console.log('[CREATE_SU] Processing due updates...')
    await processDueStrategyUpdates()
    console.log('[CREATE_SU] Done')
    
  } catch (e: any) {
    console.error('[CREATE_SU] Error:', e?.message || e)
  }
}

main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1) })
