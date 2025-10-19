#!/usr/bin/env tsx

/**
 * Test script pro nový OVERHEAT screener
 * Ověří, že přepálené altcoiny jsou správně identifikovány podle přísných kritérií
 */

import { buildMarketRawSnapshot } from '../server/fetcher/binance'
import { computeM2Lite } from '../services/features/compute_features'
import { selectCandidates } from '../services/signals/candidate_selector'

async function testOverheatScreener() {
  console.log('🔥 Testování OVERHEAT screeneru...\n')
  
  try {
    // 1. Načti market data
    console.log('📊 Načítám market data...')
    const snapshot = await buildMarketRawSnapshot({ 
      universeStrategy: 'gainers', 
      desiredTopN: 50,
      fresh: true 
    })
    console.log(`✅ Načteno ${snapshot.universe.length} kandidátů`)
    
    // 2. Vypočítej features
    console.log('🧮 Vypočítávám features...')
    const features = computeM2Lite(snapshot)
    console.log(`✅ Features vypočítány pro ${features.universe.length} coinů`)
    
    // 3. Spusť overheat screening
    console.log('🔍 Spouštím OVERHEAT screening...')
    const candidates = selectCandidates(features, snapshot, {
      decisionFlag: 'OK',
      allowWhenNoTrade: false,
      limit: 20,
      cfg: {
        atr_pct_min: 1,
        atr_pct_max: 12,
        min_liquidity_usdt: 50000
      },
      canComputeSimPreview: false,
      finalPickerStatus: 'success',
      universeStrategy: 'overheat'  // 🔥 KRITICKÉ: Předej overheat strategii!
    } as any)
    
    console.log(`✅ Nalezeno ${candidates.length} overheat kandidátů\n`)
    
    // 4. Detailní analýza top kandidátů
    console.log('📋 TOP OVERHEAT KANDIDÁTI:')
    console.log('=' .repeat(80))
    
    candidates.slice(0, 10).forEach((c, idx) => {
      const coin = features.universe.find(u => u.symbol === c.symbol)
      if (!coin) return
      
      console.log(`\n${idx + 1}. ${c.symbol} (Score: ${c.score.toFixed(2)})`)
      console.log(`   💰 Price: $${coin.price?.toFixed(4) || 'N/A'}`)
      console.log(`   📈 RSI M15: ${coin.RSI_M15?.toFixed(1) || 'N/A'} | RSI H1: ${coin.RSI_H1?.toFixed(1) || 'N/A'}`)
      console.log(`   📊 VWAP M15: $${coin.vwap_m15?.toFixed(4) || 'N/A'} | VWAP Rel: ${coin.vwap_rel_M15?.toFixed(3) || 'N/A'}`)
      console.log(`   💸 Funding: ${((coin.funding || 0) * 100).toFixed(4)}%`)
      console.log(`   📦 OI Change: ${coin.oi_change_pct_h1?.toFixed(2) || 'N/A'}%`)
      console.log(`   📏 ATR H1: ${coin.atr_pct_H1?.toFixed(2) || 'N/A'}%`)
      console.log(`   🎯 H1 Range Pos: ${coin.h1_range_pos_pct?.toFixed(1) || 'N/A'}%`)
      console.log(`   📊 Upper Wick: ${coin.upper_wick_ratio_m15?.toFixed(3) || 'N/A'}`)
      console.log(`   💧 Spread: ${coin.spread_bps?.toFixed(1) || 'N/A'} bps`)
      console.log(`   📈 24h Return: ${coin.ret_24h_pct?.toFixed(2) || 'N/A'}%`)
      
      // Overheat specifické metriky
      const vwapDist = coin.vwap_m15 && coin.price && coin.atr_pct_H1 
        ? ((coin.price - coin.vwap_m15) / (coin.price * coin.atr_pct_H1 / 100)).toFixed(2)
        : 'N/A'
      console.log(`   🔥 VWAP Distance (ATR): ${vwapDist}x`)
      
      const bearStack = coin.ema20_H1 && coin.ema50_H1 
        ? (coin.ema20_H1 < coin.ema50_H1 ? '✅' : '❌')
        : 'N/A'
      console.log(`   📉 Bear Stack: ${bearStack}`)
    })
    
    // 5. Statistiky
    console.log('\n' + '=' .repeat(80))
    console.log('📊 OVERHEAT STATISTIKY:')
    
    const avgRsiM15 = candidates.reduce((sum, c) => {
      const coin = features.universe.find(u => u.symbol === c.symbol)
      return sum + (coin?.RSI_M15 || 0)
    }, 0) / candidates.length
    
    const avgFunding = candidates.reduce((sum, c) => {
      const coin = features.universe.find(u => u.symbol === c.symbol)
      return sum + (coin?.funding || 0)
    }, 0) / candidates.length
    
    const avgVwapDist = candidates.reduce((sum, c) => {
      const coin = features.universe.find(u => u.symbol === c.symbol)
      if (!coin?.vwap_m15 || !coin?.price || !coin?.atr_pct_H1) return sum
      return sum + ((coin.price - coin.vwap_m15) / (coin.price * coin.atr_pct_H1 / 100))
    }, 0) / candidates.length
    
    console.log(`   📈 Průměrný RSI M15: ${avgRsiM15.toFixed(1)}`)
    console.log(`   💸 Průměrný Funding: ${(avgFunding * 100).toFixed(4)}%`)
    console.log(`   🔥 Průměrná VWAP Distance: ${avgVwapDist.toFixed(2)}x ATR`)
    console.log(`   🎯 Tier rozložení: ${candidates.filter(c => c.tier === 'HOT').length} HOT, ${candidates.filter(c => c.tier === 'ALERT').length} ALERT`)
    
    console.log('\n✅ OVERHEAT screener test dokončen!')
    
  } catch (error) {
    console.error('❌ Chyba při testování overheat screeneru:', error)
    process.exit(1)
  }
}

// Spusť test
testOverheatScreener()
