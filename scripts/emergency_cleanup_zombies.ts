#!/usr/bin/env tsx
import { getBinanceAPI, getWaitingTpList, cleanupWaitingTpForSymbol } from '../services/trading/binance_futures'
import fs from 'node:fs'
import path from 'node:path'

async function emergencyCleanupZombies() {
  console.log('[EMERGENCY_ZOMBIE_CLEANUP_START]')
  
  try {
    const api = getBinanceAPI()
    
    // Read directly from disk file (in-memory might be empty after restart)
    const waitingFile = path.resolve(process.cwd(), 'runtime/waiting_tp.json')
    let waitingList: any[] = []
    
    if (fs.existsSync(waitingFile)) {
      const raw = fs.readFileSync(waitingFile, 'utf8')
      const parsed = JSON.parse(raw)
      waitingList = Array.isArray(parsed?.waiting) ? parsed.waiting : []
    }
    
    console.log('[ZOMBIE_CHECK]', { total_waiting: waitingList.length, source: 'disk_file' })
    
    let cleanedCount = 0
    
    for (const w of waitingList) {
      try {
        // Check age - anything older than 10 minutes with no position is zombie
        const ageMs = Date.now() - new Date(w.since).getTime()
        const isOld = ageMs > 10 * 60 * 1000 // 10 minutes
        const noPosition = w.positionSize === 0
        const noChecks = w.checks === 0
        
        if (isOld && noPosition && noChecks) {
          // These orders have been waiting > 10 min with no position and no successful checks
          // This is a strong indicator they are zombies from failed entry orders
          
          console.log('[ZOMBIE_DETECTED]', { 
            symbol: w.symbol, 
            age_minutes: Math.round(ageMs / 60000),
            since: w.since,
            reason: 'age_based_cleanup'
          })
          
          // Remove from our list - we'll write back to disk at the end
          waitingList = waitingList.filter(item => item.symbol !== w.symbol)
          cleanedCount++
          console.log('[ZOMBIE_CLEANED]', { 
            symbol: w.symbol, 
            age_minutes: Math.round(ageMs / 60000),
            since: w.since,
            method: 'age_based'
          })
        }
      } catch (e) {
        console.error('[ZOMBIE_CLEANUP_ERROR]', { symbol: w.symbol, error: (e as any)?.message })
      }
    }
    
    // Write cleaned list back to disk
    try {
      const updatedFile = {
        ts: new Date().toISOString(),
        waiting: waitingList
      }
      fs.writeFileSync(waitingFile, JSON.stringify(updatedFile, null, 2), 'utf8')
      console.log('[ZOMBIE_FILE_UPDATED]', { symbols_remaining: waitingList.length })
    } catch (fileErr) {
      console.error('[ZOMBIE_FILE_WRITE_ERROR]', (fileErr as any)?.message || fileErr)
    }
    
    console.log('[EMERGENCY_ZOMBIE_CLEANUP_DONE]', { 
      total_processed: waitingList.length + cleanedCount,
      cleaned: cleanedCount,
      remaining: waitingList.length
    })
    
  } catch (e) {
    console.error('[EMERGENCY_CLEANUP_FAILED]', (e as any)?.message || e)
  }
}

// Run immediately
emergencyCleanupZombies().then(() => {
  console.log('[EMERGENCY_CLEANUP_COMPLETE]')
  process.exit(0)
}).catch(e => {
  console.error('[EMERGENCY_CLEANUP_FATAL]', e)
  process.exit(1)
})
