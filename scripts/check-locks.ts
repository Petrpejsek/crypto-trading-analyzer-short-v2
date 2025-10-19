#!/usr/bin/env tsx
/**
 * Check and manage process locks
 * 
 * Usage:
 *   npm run locks:check      # Check lock status
 *   npm run locks:clear      # Force clear all locks
 */

import { getLockInfo, forceRemoveLock } from '../server/lib/processLock'

const args = process.argv.slice(2)
const command = args[0] || 'check'

function checkLocks(): void {
  console.log('='.repeat(60))
  console.log('PROCESS LOCK STATUS')
  console.log('='.repeat(60))
  
  const processes: Array<'backend' | 'worker'> = ['backend', 'worker']
  let hasLocks = false
  
  for (const processType of processes) {
    const lockInfo = getLockInfo(processType)
    
    if (lockInfo) {
      hasLocks = true
      console.log(`\n[${processType.toUpperCase()}] LOCKED`)
      console.log(`  PID:         ${lockInfo.pid}`)
      console.log(`  Trade Side:  ${lockInfo.tradeSide}`)
      console.log(`  Process:     ${lockInfo.processName}`)
      console.log(`  Started:     ${lockInfo.started}`)
      console.log(`  Status:      ✅ RUNNING`)
    } else {
      console.log(`\n[${processType.toUpperCase()}] FREE`)
      console.log(`  Status:      ⚪ No lock (available to start)`)
    }
  }
  
  console.log('\n' + '='.repeat(60))
  
  if (!hasLocks) {
    console.log('✅ No active locks - safe to start new instances')
  } else {
    console.log('⚠️  Active locks found - instances are running')
    console.log('To force clear locks: npm run locks:clear')
  }
  
  console.log('='.repeat(60))
}

function clearLocks(): void {
  console.log('⚠️  FORCE CLEARING ALL LOCKS...')
  
  const processes: Array<'backend' | 'worker'> = ['backend', 'worker']
  
  for (const processType of processes) {
    const lockInfo = getLockInfo(processType)
    
    if (lockInfo) {
      console.log(`  Removing lock for ${processType} (PID ${lockInfo.pid})`)
      forceRemoveLock(processType)
    }
  }
  
  console.log('✅ All locks cleared')
  console.log('Note: This does NOT stop running processes!')
  console.log('If processes are still running, stop them with: pm2 stop all')
}

switch (command) {
  case 'check':
  case 'status':
    checkLocks()
    break
    
  case 'clear':
  case 'force-clear':
    clearLocks()
    break
    
  default:
    console.error(`Unknown command: ${command}`)
    console.error('Usage:')
    console.error('  npm run locks:check   # Check lock status')
    console.error('  npm run locks:clear   # Force clear all locks')
    process.exit(1)
}

