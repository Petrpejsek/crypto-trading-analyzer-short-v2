export type TradingStatus = 'BEST' | 'OK' | 'AVOID'

export type TradingPeriod = {
  id: string
  day: number      // 0-6, kde 0=neděle, 1=pondělí, ..., 6=sobota
  fromHour: number // inclusive, 0-23
  toHour: number   // exclusive, 0-24, may wrap if toHour < fromHour
  status: TradingStatus
  short: string
  detail: string
}

// Kompletní rozvrh pro všechny dny v týdnu (Europe/Prague timezone)
// Den 0 = Neděle, 1 = Pondělí, ..., 6 = Sobota
export const TRADING_PERIODS: TradingPeriod[] = [
  // ========== PONDĚLÍ (Den 1) ==========
  {
    id: 'mon_asia',
    day: 1,
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Trh se probouzí po víkendu.',
    detail: 'Trh se probouzí po víkendu – slabé objemy, časté whipsawy.'
  },
  {
    id: 'mon_eu_open',
    day: 1,
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'Evropa otevírá, testování hranic.',
    detail: 'Evropa otevírá, trh testuje víkendové hranice.'
  },
  {
    id: 'mon_eu_pre_us',
    day: 1,
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Klidné pásmo, čekání na USA.',
    detail: 'Přechodné klidné pásmo, obchodníci čekají na USA.'
  },
  {
    id: 'mon_us_open',
    day: 1,
    fromHour: 15,
    toHour: 16,
    status: 'AVOID',
    short: 'US open – extrémní volatilita.',
    detail: 'US open – extrémní volatilita, plno likvidací.'
  },
  {
    id: 'mon_us_post_open',
    day: 1,
    fromHour: 16,
    toHour: 17,
    status: 'OK',
    short: 'Hledání směru po otevření.',
    detail: 'Trh hledá směr po otevření USA.'
  },
  {
    id: 'mon_us_session',
    day: 1,
    fromHour: 17,
    toHour: 23,
    status: 'BEST',
    short: 'Hlavní pohyb dne, vysoká likvidita.',
    detail: 'Hlavní pohyb dne, likvidita vysoká, trend se potvrzuje.'
  },
  {
    id: 'mon_night',
    day: 1,
    fromHour: 23,
    toHour: 1,
    status: 'OK',
    short: 'Konec dne, objemy mizí.',
    detail: 'Konec dne, objemy mizí, vstupy jen výjimečně.'
  },

  // ========== ÚTERÝ (Den 2) ==========
  {
    id: 'tue_asia',
    day: 2,
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Asie pomalá, reakce na pondělí.',
    detail: 'Asie pomalá, jen menší reakce na pondělí.'
  },
  {
    id: 'tue_eu_open',
    day: 2,
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'Evropa určuje směr dne.',
    detail: 'Evropa začíná určovat směr – první průrazy dne.'
  },
  {
    id: 'tue_eu_pre_us',
    day: 2,
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Klidnější fáze, nabírání pozic.',
    detail: 'Klidnější fáze, trh nabírá pozice.'
  },
  {
    id: 'tue_us_open',
    day: 2,
    fromHour: 15,
    toHour: 16,
    status: 'AVOID',
    short: 'US open – divoké fakeouty.',
    detail: 'US open – divoké fakeouty, nebezpečné pro vstupy.'
  },
  {
    id: 'tue_us_post_open',
    day: 2,
    fromHour: 16,
    toHour: 17,
    status: 'BEST',
    short: 'Potvrzení trendu, čisté směry.',
    detail: 'Po open se potvrzuje trend, čisté směry.'
  },
  {
    id: 'tue_us_session',
    day: 2,
    fromHour: 17,
    toHour: 23,
    status: 'BEST',
    short: 'Nejaktivnější část týdne.',
    detail: 'Nejaktivnější část týdne – ideální intraday okno.'
  },
  {
    id: 'tue_night',
    day: 2,
    fromHour: 23,
    toHour: 1,
    status: 'OK',
    short: 'Dojezd dne, pomalejší volatilita.',
    detail: 'Dojezd dne, pomalejší volatilita.'
  },

  // ========== STŘEDA (Den 3) ==========
  {
    id: 'wed_asia',
    day: 3,
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Asijská seance, úzké range.',
    detail: 'Asijská seance, většinou úzké range.'
  },
  {
    id: 'wed_eu_open',
    day: 3,
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'Evropa reaguje na úterý.',
    detail: 'Evropa reaguje na úterý – první dynamika dne.'
  },
  {
    id: 'wed_eu_pre_us',
    day: 3,
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Konsolidace před US daty.',
    detail: 'Konsolidace před americkými daty.'
  },
  {
    id: 'wed_us_open',
    day: 3,
    fromHour: 15,
    toHour: 16,
    status: 'AVOID',
    short: 'US open – prudké výstřely.',
    detail: 'US open – prudké výstřely oběma směry.'
  },
  {
    id: 'wed_us_post_open',
    day: 3,
    fromHour: 16,
    toHour: 17,
    status: 'BEST',
    short: 'Trh se ustaluje, potvrzení trendu.',
    detail: 'Trh se ustaluje, trend se potvrzuje.'
  },
  {
    id: 'wed_us_session',
    day: 3,
    fromHour: 17,
    toHour: 23,
    status: 'BEST',
    short: 'Nejaktivnější den týdne.',
    detail: 'Nejaktivnější den týdne, vysoká kvalita pohybů.'
  },
  {
    id: 'wed_night',
    day: 3,
    fromHour: 23,
    toHour: 1,
    status: 'OK',
    short: 'Dojezd, pomalejší obchodování.',
    detail: 'Dojezd, pomalejší obchodování.'
  },

  // ========== ČTVRTEK (Den 4) ==========
  {
    id: 'thu_asia',
    day: 4,
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Asie slabá, reakce na středu.',
    detail: 'Asie slabá, menší reakce na středu.'
  },
  {
    id: 'thu_eu_open',
    day: 4,
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'EU open – návrat volatility.',
    detail: 'EU open – návrat volatility po ránu.'
  },
  {
    id: 'thu_eu_pre_us',
    day: 4,
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Vyčkávání na americkou seanci.',
    detail: 'Vyčkávání na americkou seanci.'
  },
  {
    id: 'thu_us_open',
    day: 4,
    fromHour: 15,
    toHour: 16,
    status: 'AVOID',
    short: 'Chaotické US open.',
    detail: 'Chaotické US open, rychlé likvidace.'
  },
  {
    id: 'thu_us_post_open',
    day: 4,
    fromHour: 16,
    toHour: 17,
    status: 'BEST',
    short: 'Trend se vyjasňuje, ideální vstupy.',
    detail: 'Trend se vyjasňuje, ideální vstupy.'
  },
  {
    id: 'thu_us_session',
    day: 4,
    fromHour: 17,
    toHour: 23,
    status: 'BEST',
    short: 'Plná likvidita, silné trendy.',
    detail: 'Plná likvidita, silné trendy – nejlepší okno týdne.'
  },
  {
    id: 'thu_night',
    day: 4,
    fromHour: 23,
    toHour: 1,
    status: 'OK',
    short: 'Trh zpomaluje, čisté setupy.',
    detail: 'Trh zpomaluje, pouze čisté setupy.'
  },

  // ========== PÁTEK (Den 5) ==========
  {
    id: 'fri_asia',
    day: 5,
    fromHour: 1,
    toHour: 9,
    status: 'AVOID',
    short: 'Slabá Asie, závěr týdne.',
    detail: 'Slabá Asie, závěr týdne.'
  },
  {
    id: 'fri_eu_open',
    day: 5,
    fromHour: 9,
    toHour: 11,
    status: 'OK',
    short: 'Evropa uzavírá pozice.',
    detail: 'Evropa uzavírá pozice, lehká volatilita.'
  },
  {
    id: 'fri_eu_pre_us',
    day: 5,
    fromHour: 11,
    toHour: 15,
    status: 'OK',
    short: 'Klid před US daty, opatrnost.',
    detail: 'Klid před americkými daty, trh opatrný.'
  },
  {
    id: 'fri_us_open',
    day: 5,
    fromHour: 15,
    toHour: 16,
    status: 'AVOID',
    short: 'US open – chaos, silné reverzy.',
    detail: 'US open – chaos, silné reverzy.'
  },
  {
    id: 'fri_us_post_open',
    day: 5,
    fromHour: 16,
    toHour: 17,
    status: 'OK',
    short: 'Po open často falešné potvrzení.',
    detail: 'Po open často falešné potvrzení trendu.'
  },
  {
    id: 'fri_us_session',
    day: 5,
    fromHour: 17,
    toHour: 22,
    status: 'BEST',
    short: 'Solidní pohyby, kratší okno.',
    detail: 'Ještě solidní pohyby, ale kratší než jindy.'
  },
  {
    id: 'fri_us_cooldown',
    day: 5,
    fromHour: 22,
    toHour: 23,
    status: 'OK',
    short: 'Zavírání rizik, objemy mizí.',
    detail: 'Zavírají se rizika, objemy mizí.'
  },
  {
    id: 'fri_night',
    day: 5,
    fromHour: 23,
    toHour: 1,
    status: 'AVOID',
    short: 'Přeliv do víkendu.',
    detail: 'Přeliv do víkendu, minimální likvidita.'
  },

  // ========== SOBOTA (Den 6) ==========
  {
    id: 'sat_early',
    day: 6,
    fromHour: 1,
    toHour: 12,
    status: 'AVOID',
    short: 'Tenká kniha, minimální pohyb.',
    detail: 'Tenká kniha, minimální pohyb.'
  },
  {
    id: 'sat_noon',
    day: 6,
    fromHour: 12,
    toHour: 16,
    status: 'OK',
    short: 'Krátké pulzy – reakce na altcoiny.',
    detail: 'Krátké pulzy – reakce na altcoiny.'
  },
  {
    id: 'sat_afternoon',
    day: 6,
    fromHour: 16,
    toHour: 19,
    status: 'OK',
    short: 'Mírné oživení, low-vol trend.',
    detail: 'Mírné oživení, často low-vol trend.'
  },
  {
    id: 'sat_night',
    day: 6,
    fromHour: 19,
    toHour: 1,
    status: 'AVOID',
    short: 'Trh utichá, volume mizí.',
    detail: 'Trh utichá, volume mizí.'
  },

  // ========== NEDĚLE (Den 0) ==========
  {
    id: 'sun_early',
    day: 0,
    fromHour: 1,
    toHour: 12,
    status: 'AVOID',
    short: 'Neaktivní trh, nízká likvidita.',
    detail: 'Neaktivní trh, minimální likvidita.'
  },
  {
    id: 'sun_noon',
    day: 0,
    fromHour: 12,
    toHour: 16,
    status: 'OK',
    short: 'Budování pozic před pondělím.',
    detail: 'Pomalé budování pozic před pondělím.'
  },
  {
    id: 'sun_afternoon',
    day: 0,
    fromHour: 16,
    toHour: 20,
    status: 'OK',
    short: 'Lehká aktivita, přestavby.',
    detail: 'Lehká aktivita, drobné přestavby portfolií.'
  },
  {
    id: 'sun_evening',
    day: 0,
    fromHour: 20,
    toHour: 23,
    status: 'OK',
    short: 'Krátké squeeze pohyby.',
    detail: 'Krátké squeeze pohyby – vhodné jen pro rychlé scalp.'
  },
  {
    id: 'sun_night',
    day: 0,
    fromHour: 23,
    toHour: 1,
    status: 'AVOID',
    short: 'Klid před otevřením Evropy.',
    detail: 'Klid před otevřením Evropy.'
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
  
  // Validate basic fields
  for (const p of periods) {
    if (!p.id) problems.push('Missing id')
    if (seenIds.has(p.id)) problems.push(`Duplicate id: ${p.id}`)
    seenIds.add(p.id)
    
    const d = Number(p.day)
    const fh = Number(p.fromHour)
    const th = Number(p.toHour)
    
    if (!Number.isFinite(d) || d < 0 || d > 6) problems.push(`day out of range (0-6): ${p.id}`)
    if (!Number.isFinite(fh) || fh < 0 || fh > 23) problems.push(`fromHour out of range: ${p.id}`)
    if (!Number.isFinite(th) || th < 0 || th > 24) problems.push(`toHour out of range: ${p.id}`)
    if (fh === th) problems.push(`fromHour == toHour (empty window): ${p.id}`)
  }
  
  // Build coverage map per day: day -> hour -> period IDs
  const coverage: Record<number, Record<number, string[]>> = {}
  for (let d = 0; d <= 6; d++) {
    coverage[d] = {}
    for (let h = 0; h < 24; h++) coverage[d][h] = []
  }
  
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
  
  // Check coverage per day
  for (const p of periods) {
    const hours = expand(p.fromHour, p.toHour)
    for (const h of hours) {
      coverage[p.day][h].push(p.id)
    }
  }
  
  // Check each day for gaps and overlaps
  const dayNames = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota']
  for (let d = 0; d <= 6; d++) {
    for (let h = 0; h < 24; h++) {
      if (coverage[d][h].length === 0) {
        problems.push(`${dayNames[d]} - Uncovered hour: ${String(h).padStart(2,'0')}`)
      }
      if (coverage[d][h].length > 1) {
        problems.push(`${dayNames[d]} - Overlapping periods at hour ${String(h).padStart(2,'0')}: ${coverage[d][h].join(',')}`)
      }
    }
  }
  
  return problems
}


