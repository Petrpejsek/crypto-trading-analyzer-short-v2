import { TRADING_PERIODS, type TradingPeriod, type TradingStatus } from './config'

const PRAGUE_TZ = 'Europe/Prague'

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function getPragueParts(d: Date | number = Date.now()): DateParts {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: PRAGUE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const parts = dtf.formatToParts(new Date(d))
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === type)?.value || '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  }
}

export function pragueNow(): DateParts { return getPragueParts(Date.now()) }

export function formatClock(parts: DateParts, withSeconds = false): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return withSeconds
    ? `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
    : `${pad(parts.hour)}:${pad(parts.minute)}`
}

export function buildPragueDate(parts: Partial<DateParts>): Date {
  // Build UTC time that corresponds to desired Prague wall-clock via Intl (no hardcoded offsets)
  // Strategy: format target wall-clock and parse back by searching for UTC that yields those parts – approximate by using local Date and adjusting via timeZoneName short offset
  // Simpler approach: create ISO string with provided Y-M-D and time, then interpret as local Prague by using Date.UTC and let display be irrelevant since we only use deltas
  // For our use (differences within < 24h) we can approximate by combining current date in Prague and replacing H:M.
  const now = pragueNow()
  const target: DateParts = {
    year: parts.year ?? now.year,
    month: parts.month ?? now.month,
    day: parts.day ?? now.day,
    hour: parts.hour ?? now.hour,
    minute: parts.minute ?? now.minute,
    second: parts.second ?? 0
  }
  // Construct a date by formatting a string and letting Date parse in UTC by appending 'Z'. We'll correct using Intl comparisons.
  // Create a Date for the target in Prague by guessing UTC and iterating +/- 2 hours to match hour:minute via Intl
  const guess = new Date(Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second))
  const candidates: Date[] = []
  for (let offH = -3; offH <= 3; offH++) {
    candidates.push(new Date(guess.getTime() - offH * 3600 * 1000))
  }
  for (const c of candidates) {
    const p = getPragueParts(c)
    if (p.year === target.year && p.month === target.month && p.day === target.day && p.hour === target.hour && p.minute === target.minute) {
      return c
    }
  }
  // Fallback to guess (should not happen often)
  return guess
}

export function currentPeriod(periods: TradingPeriod[], at: Date | number = Date.now()): TradingPeriod | null {
  const now = getPragueParts(at)
  const h = now.hour
  const includesHour = (p: TradingPeriod, hour: number): boolean => {
    const from = p.fromHour
    const to = p.toHour
    if (from < to) return hour >= from && hour < to
    // wrap-around (e.g., 23->1 covers 23, 0)
    return hour >= from || hour < to
  }
  for (const p of periods) {
    if (includesHour(p, h)) return p
  }
  return null
}

export function hourStatusMap(periods: TradingPeriod[]): Record<number, TradingPeriod> {
  const map: Record<number, TradingPeriod> = {} as any
  const covers = (p: TradingPeriod, h: number): boolean => {
    if (p.fromHour < p.toHour) return h >= p.fromHour && h < p.toHour
    return h >= p.fromHour || h < p.toHour
  }
  for (let h = 0; h < 24; h++) {
    const found = periods.find(p => covers(p, h))
    if (found) map[h] = found
  }
  return map
}

export function nextBestStart(periods: TradingPeriod[], at: Date | number = Date.now()): { period: TradingPeriod; start: Date } | null {
  const best = periods.filter(p => p.status === 'BEST')
  if (!best.length) return null
  const nowParts = getPragueParts(at)
  const nowDate = new Date(typeof at === 'number' ? at : (at as Date).getTime())
  let bestCandidate: { period: TradingPeriod; start: Date } | null = null

  for (const p of best) {
    // Today start
    let start = buildPragueDate({ year: nowParts.year, month: nowParts.month, day: nowParts.day, hour: p.fromHour, minute: 0, second: 0 })
    // If start already passed or equal to current minute, schedule to next day
    const curParts = getPragueParts(nowDate)
    const curHM = curParts.hour * 60 + curParts.minute
    const startHM = p.fromHour * 60
    if (startHM <= curHM) {
      // move to tomorrow in Prague
      const tomorrow = new Date(start.getTime() + 24 * 3600 * 1000)
      const tParts = getPragueParts(tomorrow)
      start = buildPragueDate({ year: tParts.year, month: tParts.month, day: tParts.day, hour: p.fromHour, minute: 0, second: 0 })
    }
    if (!bestCandidate || start.getTime() < bestCandidate.start.getTime()) {
      bestCandidate = { period: p, start }
    }
  }
  return bestCandidate
}

export function currentBestEnd(periods: TradingPeriod[], at: Date | number = Date.now()): { period: TradingPeriod; end: Date } | null {
  const cur = currentPeriod(periods, at)
  if (!cur || cur.status !== 'BEST') return null
  const now = getPragueParts(at)
  // End is today at toHour if non-wrap; otherwise if wraps, end is next day at toHour
  let end = buildPragueDate({ year: now.year, month: now.month, day: now.day, hour: cur.toHour % 24, minute: 0, second: 0 })
  // If cur.fromHour > cur.toHour, it wraps past midnight so end should be next day
  if (cur.fromHour > cur.toHour || (cur.fromHour === 23 && cur.toHour === 0)) {
    end = new Date(end.getTime() + 24 * 3600 * 1000)
  }
  // If end is earlier than now due to DST shift etc., push by 24h
  if (end.getTime() <= (typeof at === 'number' ? at : (at as Date).getTime())) {
    end = new Date(end.getTime() + 24 * 3600 * 1000)
  }
  return { period: cur, end }
}

export function diffMsHuman(ms: number): { h: number; m: number } {
  const totalMin = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return { h, m }
}

export function pad2(n: number): string { return String(n).padStart(2, '0') }


