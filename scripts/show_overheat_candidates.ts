#!/usr/bin/env tsx
/**
 * Helper script pro zobrazení losers_overheat_relief kandidátů
 * 
 * Použití:
 *   npx tsx scripts/show_overheat_candidates.ts
 * 
 * Zobrazí aktuální kandidáty s detailními metrikami
 */

import { selectCandidates } from '../services/signals/candidate_selector'
import { buildMarketRawSnapshot } from '../server/fetcher/binance'
import { computeFeatures } from '../services/features/compute'
import type { FeaturesSnapshot } from '../types/features'

async function main() {
  console.log('🔍 Fetching market data...\n')
  
  try {
    // Build snapshot with 'losers' strategy
    const snapshot = await buildMarketRawSnapshot({ 
      universeStrategy: 'losers',
      desiredTopN: 100,
      fresh: true 
    })
    
    console.log(`✅ Fetched ${snapshot.coins.length} coins\n`)
    
    // Compute features
    console.log('📊 Computing features...\n')
    const features: FeaturesSnapshot = computeFeatures(snapshot)
    
    // Select candidates
    console.log('🎯 Selecting candidates...\n')
    const candidates = selectCandidates(features, snapshot, {
      decisionFlag: 'OK',
      allowWhenNoTrade: false,
      limit: 100,
      cfg: {
        atr_pct_min: 1.0,
        atr_pct_max: 12.0,
        min_liquidity_usdt: 1_000_000
      },
      universeStrategy: 'losers'
    })
    
    // Filter only losers_overheat_relief
    const overheatCandidates = candidates.filter(c => c.archetype === 'losers_overheat_relief')
    
    console.log('═══════════════════════════════════════════════════════')
    console.log(`📈 LOSERS OVERHEAT RELIEF CANDIDATES: ${overheatCandidates.length}`)
    console.log('═══════════════════════════════════════════════════════\n')
    
    if (overheatCandidates.length === 0) {
      console.log('⚠️  No overheat relief candidates found.')
      console.log('   Možné důvody:')
      console.log('   1) Archetype není enabled v config/candidates.json')
      console.log('   2) Žádné coiny aktuálně nesplňují přísná kritéria')
      console.log('   3) Trh není v relief rally režimu\n')
      
      // Show other archetypes
      console.log('📊 Další dostupné kandidáty:')
      const archetypeCounts = candidates.reduce((acc, c) => {
        acc[c.archetype || 'unknown'] = (acc[c.archetype || 'unknown'] || 0) + 1
        return acc
      }, {} as Record<string, number>)
      
      Object.entries(archetypeCounts).forEach(([arch, count]) => {
        console.log(`   ${arch}: ${count}`)
      })
      
      return
    }
    
    // Display candidates with details
    overheatCandidates
      .sort((a, b) => b.score - a.score)
      .forEach((c, idx) => {
        console.log(`${idx + 1}. ${c.symbol}`)
        console.log(`   Score: ${c.score.toFixed(4)} | Basket: ${c.basket}`)
        console.log(`   ${c.reason}`)
        console.log(`   ───────────────────────────────────────────`)
        console.log(`   📉 Returns:`)
        console.log(`      24h: ${c.ret24hPct?.toFixed(2)}% | 1h: ${c.ret60mPct?.toFixed(2)}% | 15m: ${c.ret15mPct?.toFixed(2)}%`)
        console.log(`   📊 RSI:`)
        console.log(`      M15: ${c.rsiM15?.toFixed(0)} | H1: ${c.rsiH1?.toFixed(0)}`)
        console.log(`   💧 Position:`)
        console.log(`      VWAP rel: ${c.vwapRelM15?.toFixed(3)} | H1 range: ${c.posInH1RangePct?.toFixed(1)}%`)
        console.log(`   💰 Liquidity:`)
        console.log(`      Volume: $${(c.liquidityUsd / 1_000_000).toFixed(2)}M | ATR: ${c.atrPctH1?.toFixed(2)}%`)
        console.log(`   🧲 Flow:`)
        console.log(`      Funding Z: ${c.fundingZ?.toFixed(2) || 'N/A'} | OI chg: ${c.oiChangePctH1?.toFixed(2) || 'N/A'}%`)
        console.log('')
      })
    
    console.log('═══════════════════════════════════════════════════════')
    console.log(`✅ Found ${overheatCandidates.length} overheat relief candidates`)
    console.log('═══════════════════════════════════════════════════════\n')
    
    // Summary stats
    const primeCount = overheatCandidates.filter(c => c.basket === 'Prime').length
    const strongCount = overheatCandidates.filter(c => c.basket === 'Strong Watch').length
    const specCount = overheatCandidates.filter(c => c.basket === 'Speculative').length
    
    console.log('📊 Basket Distribution:')
    console.log(`   Prime: ${primeCount}`)
    console.log(`   Strong Watch: ${strongCount}`)
    console.log(`   Speculative: ${specCount}`)
    console.log('')
    
    const avgScore = overheatCandidates.reduce((sum, c) => sum + c.score, 0) / overheatCandidates.length
    console.log(`📈 Average Score: ${avgScore.toFixed(4)}`)
    console.log('')
    
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

main()

