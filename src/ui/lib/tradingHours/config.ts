export type TradingStatus = 'BEST' | 'OK' | 'AVOID'

export type TradingPeriod = {
  id: string
  fromHour: number // inclusive, 0-23
  toHour: number   // exclusive, 0-24, may wrap if toHour < fromHour
  status: TradingStatus
  short: string
  detail: string
}

// Statická okna v lokální zóně Europe/Prague (toHour je exkluzivní)
export const TRADING_PERIODS: TradingPeriod[] = [
  {
    id: 'overlap_eu_us',
    fromHour: 15,
    toHour: 17,
    status: 'BEST',
    short: 'Překryv EU+US – nejvyšší objemy.',
    detail: 'Nejsilnější okno dne. Vysoká volatilita, průrazy, stophunty. Vhodné pro intradenní momentum a breakouty.'
  },
  {
    id: 'us_session',
    fromHour: 17,
    toHour: 23,
    status: 'BEST',
    short: 'US seance – vysoká volatilita.',
    detail: 'Vysoká likvidita, trendové pohyby. Intradenní obchodování má nejlepší RR. Pozor na rychlé reverze po makro datech.'
  },
  {
    id: 'eu_open',
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'Otevírá Evropa, reakce na Asii.',
    detail: 'Ranní setupy, přenos nočních pohybů. Vhodné na swingové vstupy a přípravu plánů.'
  },
  {
    id: 'eu_pre_us',
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Střední likvidita, příprava na US.',
    detail: 'Čekání na US data. Lepší pro řízené vstupy do swingů, pozor na falešné průrazy.'
  },
  {
    id: 'us_cooldown',
    fromHour: 23,
    toHour: 1,
    status: 'OK',
    short: 'Dojezd US – slábnou objemy.',
    detail: 'Likvidita klesá, roste riziko skluzu. Pouze čisté setupy, jinak vyčkat.'
  },
  {
    id: 'asia_session',
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Nízká likvidita – spíš neobchodovat.',
    detail: 'Technické range, časté whipsawy a SL hunty. Často korekce amerických pohybů. Nejhorší 2–6.'
  }
]

export const STATUS_EMOJI: Record<TradingStatus, string> = {
  BEST: '🟢',
  OK: '🟠',
  AVOID: '🔴'
}

export function validateTradingConfig(periods: TradingPeriod[]): string[] {
  const problems: string[] = []
  const seenIds = new Set<string>()
  for (const p of periods) {
    if (!p.id) problems.push('Missing id')
    if (seenIds.has(p.id)) problems.push(`Duplicate id: ${p.id}`)
    seenIds.add(p.id)
    const fh = Number(p.fromHour)
    const th = Number(p.toHour)
    if (!Number.isFinite(fh) || fh < 0 || fh > 23) problems.push(`fromHour out of range: ${p.id}`)
    if (!Number.isFinite(th) || th < 0 || th > 24) problems.push(`toHour out of range: ${p.id}`)
    if (fh === th) problems.push(`fromHour == toHour (empty window): ${p.id}`)
  }
  // Build hour coverage map 0..23; support wrap-around blocks
  const coverage: Record<number, string[]> = {}
  for (let h = 0; h < 24; h++) coverage[h] = []
  const expand = (from: number, to: number): number[] => {
    const out: number[] = []
    if (from < 0 || from > 23) return out
    if (to < 0 || to > 24) return out
    // exclusive to, wrap if to <= from
    let cur = from
    while (true) {
      out.push(cur)
      cur = (cur + 1) % 24
      if (from < to) {
        if (cur >= to) break
      } else {
        // wrap window, stop when came back to start
        if (cur === from) break
        // Special stop: if to == 0, stop when cur === 0
        if (to === 0 && cur === 0) break
        if (to > 0 && cur === to) break
      }
    }
    return out
  }
  for (const p of periods) {
    const hours = expand(p.fromHour, p.toHour)
    for (const h of hours) {
      coverage[h].push(p.id)
    }
  }
  for (let h = 0; h < 24; h++) {
    if (coverage[h].length === 0) problems.push(`Uncovered hour: ${String(h).padStart(2,'0')}`)
    if (coverage[h].length > 1) problems.push(`Overlapping periods at hour ${String(h).padStart(2,'0')}: ${coverage[h].join(',')}`)
  }
  return problems
}


