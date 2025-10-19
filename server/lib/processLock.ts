/**
 * Process Lock - Prevents multiple instances from running simultaneously
 * 
 * Usage:
 *   import { acquireLock, releaseLock } from './lib/processLock'
 *   acquireLock('backend') // Throws if lock already held
 *   process.on('exit', () => releaseLock('backend'))
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const RUNTIME_DIR = path.resolve(process.cwd(), 'runtime')
const LOCK_DIR = path.join(RUNTIME_DIR, 'locks')

// Ensure lock directory exists
if (!fs.existsSync(RUNTIME_DIR)) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
}
if (!fs.existsSync(LOCK_DIR)) {
  fs.mkdirSync(LOCK_DIR, { recursive: true })
}

interface LockInfo {
  pid: number
  started: string
  tradeSide: string
  processName: string
}

/**
 * Get lock file path for a process type
 */
function getLockPath(processType: string): string {
  const tradeSide = (process.env.TRADE_SIDE || 'SHORT').toLowerCase()
  return path.join(LOCK_DIR, `${processType}.${tradeSide}.lock`)
}

/**
 * Check if a process is actually running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 checks if process exists without killing it
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // ESRCH means process doesn't exist
    return e?.code !== 'ESRCH'
  }
}

/**
 * Acquire exclusive lock for this process type
 * Throws if lock is already held by another running process
 */
export function acquireLock(processType: 'backend' | 'worker'): void {
  const lockPath = getLockPath(processType)
  const tradeSide = process.env.TRADE_SIDE || 'SHORT'
  const currentPid = process.pid
  
  // Check if lock file exists
  if (fs.existsSync(lockPath)) {
    try {
      const lockData = fs.readFileSync(lockPath, 'utf-8')
      const lockInfo: LockInfo = JSON.parse(lockData)
      
      // Check if the process from lock file is still running
      if (isProcessRunning(lockInfo.pid)) {
        console.error(`[PROCESS_LOCK_CONFLICT] Another ${processType} (${tradeSide}) is already running!`)
        console.error(`[PROCESS_LOCK_CONFLICT] Existing process:`, {
          pid: lockInfo.pid,
          started: lockInfo.started,
          processName: lockInfo.processName
        })
        console.error(`[PROCESS_LOCK_CONFLICT] Current attempt:`, {
          pid: currentPid,
          tradeSide
        })
        console.error(`[PROCESS_LOCK_CONFLICT] To force restart, run: kill ${lockInfo.pid}`)
        
        throw new Error(
          `LOCK_CONFLICT: ${processType} (${tradeSide}) is already running (PID: ${lockInfo.pid}). ` +
          `Cannot start duplicate instance. Stop the existing process first.`
        )
      } else {
        // Stale lock file - process is dead, clean it up
        console.warn(`[PROCESS_LOCK_STALE] Found stale lock file for PID ${lockInfo.pid}, removing...`)
        fs.unlinkSync(lockPath)
      }
    } catch (e: any) {
      // If it's our lock conflict error, re-throw it
      if (e?.message?.includes('LOCK_CONFLICT')) {
        throw e
      }
      // Otherwise, lock file is corrupted - remove it
      console.warn(`[PROCESS_LOCK_CORRUPT] Lock file corrupted, removing...`)
      fs.unlinkSync(lockPath)
    }
  }
  
  // Create new lock file
  const lockInfo: LockInfo = {
    pid: currentPid,
    started: new Date().toISOString(),
    tradeSide,
    processName: process.env.PM2_NAME || processType
  }
  
  fs.writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8')
  
  console.info(`[PROCESS_LOCK_ACQUIRED]`, {
    processType,
    tradeSide,
    pid: currentPid,
    lockFile: lockPath
  })
  
  // Auto-cleanup on exit
  const cleanup = () => releaseLock(processType)
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT_EXCEPTION]', err)
    cleanup()
    process.exit(1)
  })
}

/**
 * Release lock for this process type
 */
export function releaseLock(processType: 'backend' | 'worker'): void {
  const lockPath = getLockPath(processType)
  
  try {
    if (fs.existsSync(lockPath)) {
      const lockData = fs.readFileSync(lockPath, 'utf-8')
      const lockInfo: LockInfo = JSON.parse(lockData)
      
      // Only remove lock if it belongs to this process
      if (lockInfo.pid === process.pid) {
        fs.unlinkSync(lockPath)
        console.info(`[PROCESS_LOCK_RELEASED]`, {
          processType,
          pid: process.pid
        })
      }
    }
  } catch (e) {
    // Ignore errors during cleanup
  }
}

/**
 * Get info about current lock holder (if any)
 */
export function getLockInfo(processType: 'backend' | 'worker'): LockInfo | null {
  const lockPath = getLockPath(processType)
  
  try {
    if (fs.existsSync(lockPath)) {
      const lockData = fs.readFileSync(lockPath, 'utf-8')
      const lockInfo: LockInfo = JSON.parse(lockData)
      
      // Verify process is still running
      if (isProcessRunning(lockInfo.pid)) {
        return lockInfo
      }
    }
  } catch (e) {
    // Ignore errors
  }
  
  return null
}

/**
 * Force remove lock (use with caution!)
 */
export function forceRemoveLock(processType: 'backend' | 'worker'): void {
  const lockPath = getLockPath(processType)
  
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath)
      console.warn(`[PROCESS_LOCK_FORCE_REMOVED]`, { processType })
    }
  } catch (e) {
    console.error(`[PROCESS_LOCK_FORCE_REMOVE_ERR]`, e)
  }
}

