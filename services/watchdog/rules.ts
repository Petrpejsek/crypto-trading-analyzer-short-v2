import type { WatchdogDecision, WatchdogReason } from './types'

export type EvaluateInput = {
  type: 'LIMIT' | 'STOP' | 'STOP_MARKET' | 'MARKET' | 'STOP_LIMIT' | string
  age_min: number | null
  pDiff_pct: number | null
  atr_h1_pct: number | null
  nowUTC: string
  cutoffUTC: string
  divergenceMultiplier: number
}

function parseUTC(hhmm: string): { h: number; m: number } | null {
  const m = String(hhmm || '').match(/^\s*(\d{1,2}):(\d{2})\s*$/)
  if (!m) return null
  const h = Number(m[1]); const mm = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return { h, m: mm }
}

function isSessionCutoff(nowISO: string, cutoff: string): boolean {
  const p = parseUTC(cutoff)
  if (!p) throw new Error('SESSION_CUTOFF_UTC_invalid')
  const now = new Date(nowISO)
  const cutoffDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), p.h, p.m, 0, 0))
  return now.getTime() >= cutoffDate.getTime()
}

export function evaluate(input: EvaluateInput): WatchdogDecision {
  const { type, age_min, pDiff_pct, atr_h1_pct, nowUTC, cutoffUTC, divergenceMultiplier } = input

  // 1) SESSION_CUTOFF
  let sessionCut = false
  try { sessionCut = isSessionCutoff(nowUTC, cutoffUTC) } catch { throw }
  if (sessionCut) return { action: 'cancel', reason: 'SESSION_CUTOFF' }

  // 2) TTL
  const isSupport = ['LIMIT', 'STOP_LIMIT'].includes(String(type || '').toUpperCase())
  const isBreakout = !isSupport
  const age = Number.isFinite(age_min as any) ? (age_min as number) : null
  const atr = Number.isFinite(atr_h1_pct as any) ? (atr_h1_pct as number) : null
  const pDiff = Number.isFinite(pDiff_pct as any) ? (pDiff_pct as number) : null

  const approached = (() => {
    if (!Number.isFinite(atr as any) || !Number.isFinite(pDiff as any)) return false
    return pDiff <= 0.2 * (atr as number)
  })()

  let ttlHard = false
  let ttlSoft = false
  if (age != null) {
    if (isSupport) {
      ttlHard = age >= 60
      ttlSoft = !ttlHard && age >= 30 && !approached
    } else if (isBreakout) {
      ttlHard = age >= 25
      ttlSoft = !ttlHard && age >= 10
    }
  }

  // 3) DIVERGENCE
  const divergence = (atr != null && pDiff != null) ? (pDiff >= (atr * divergenceMultiplier)) : false

  // Priority: SESSION_CUTOFF > TTL_HARD > DIVERGENCE > TTL_SOFT > KEEP
  if (ttlHard) return { action: 'cancel', reason: 'TTL_HARD' }
  if (divergence) return { action: 'cancel', reason: 'DIVERGENCE' }
  if (ttlSoft) return { action: 'cancel', reason: 'TTL_SOFT' }
  return { action: 'keep', reason: null }
}



