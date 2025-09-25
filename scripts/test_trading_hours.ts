import { TRADING_PERIODS } from '../src/ui/lib/tradingHours/config'
import { currentPeriod, nextBestStart, currentBestEnd, getPragueParts, buildPragueDate } from '../src/ui/lib/tradingHours/time'

function assert(cond: any, msg: string) { if (!cond) throw new Error(msg) }

// Boundary mapping tests (hours relative to Europe/Prague now-date)
const boundaries: Array<[string, number, number, string|null]> = [
  ['14:59', 14, 59, 'eu_pre_us'],
  ['15:00', 15, 0, 'overlap_eu_us'],
  ['16:59', 16, 59, 'overlap_eu_us'],
  ['17:00', 17, 0, 'us_session'],
  ['22:59', 22, 59, 'us_session'],
  ['23:00', 23, 0, 'us_cooldown'],
  ['00:59', 0, 59, 'us_cooldown'],
  ['01:00', 1, 0, 'asia_session'],
  ['08:59', 8, 59, 'asia_session'],
  ['09:00', 9, 0, 'eu_open'],
  ['10:59', 10, 59, 'eu_open'],
  ['11:00', 11, 0, 'eu_pre_us'],
]

const today = getPragueParts(new Date())
for (const [label, h, m, expectedId] of boundaries) {
  const d = buildPragueDate({ year: today.year, month: today.month, day: today.day, hour: h, minute: m, second: 0 })
  const p = currentPeriod(TRADING_PERIODS, d)
  const got = p?.id || null
  if (expectedId === null) {
    // 14:59 is before 15:00 overlap; may belong to eu_pre_us depending on minute granularity, so allow non-null
    // We only assert that it's not overlap_eu_us
    assert(got !== 'overlap_eu_us', `${label} should not be overlap_eu_us`)
  } else {
    assert(got === expectedId, `${label} expected ${expectedId}, got ${got}`)
  }
}

// Next BEST from specific times
const checks: Array<[string, number, number, string]> = [
  ['14:30', 14, 30, 'overlap_eu_us'],
  ['15:30', 15, 30, 'us_session'],
  ['22:30', 22, 30, 'overlap_eu_us'],
  ['23:30', 23, 30, 'overlap_eu_us'], // next day 15:00
  ['00:30', 0, 30, 'overlap_eu_us'],  // next day 15:00
]
for (const [label, h, m, expId] of checks) {
  const d = buildPragueDate({ year: today.year, month: today.month, day: today.day, hour: h, minute: m, second: 0 })
  const next = nextBestStart(TRADING_PERIODS, d)
  assert(!!next, `${label} should have next BEST`)
  assert(next!.period.id === expId, `${label} expected next ${expId}, got ${next!.period.id}`)
}

// Current BEST end sanity when in BEST
{
  const d = buildPragueDate({ year: today.year, month: today.month, day: today.day, hour: 15, minute: 30, second: 0 })
  const cur = currentBestEnd(TRADING_PERIODS, d)
  assert(!!cur, '15:30 should be in BEST and have end')
}

console.log('Trading hours tests passed.')


