#!/usr/bin/env tsx
/**
 * Test script pro Entry Price Multiplier
 * Ověřuje, že applyEntryMultiplier funguje správně
 */

import fs from 'node:fs'
import path from 'node:path'

// Simulace různých hodnot multiplieru
const testCases = [
  { multiplier: 100.0, entryPrice: 100.0, expected: 100.0, description: 'Žádná změna (100%)' },
  { multiplier: 100.5, entryPrice: 100.0, expected: 100.5, description: '+0.5%' },
  { multiplier: 101.0, entryPrice: 100.0, expected: 101.0, description: '+1.0%' },
  { multiplier: 99.5, entryPrice: 100.0, expected: 99.5, description: '-0.5%' },
  { multiplier: 105.0, entryPrice: 100.0, expected: 105.0, description: 'Max +5%' },
  { multiplier: 95.0, entryPrice: 100.0, expected: 95.0, description: 'Min -5%' },
  { multiplier: 100.5, entryPrice: 50000.0, expected: 50250.0, description: 'BTC příklad +0.5%' },
]

async function runTests() {
  console.log('\n🧪 Entry Price Multiplier - Test Suite\n')
  
  const configPath = path.join(process.cwd(), 'config', 'trading.json')
  const originalConfig = fs.readFileSync(configPath, 'utf8')
  const config = JSON.parse(originalConfig)
  
  let passed = 0
  let failed = 0
  
  for (const testCase of testCases) {
    try {
      // Aktualizuj config
      config.ENTRY_PRICE_MULTIPLIER = testCase.multiplier
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
      
      // Importuj funkci (fresh import pro načtení nové hodnoty z configu)
      delete require.cache[require.resolve('../services/lib/entry_price_adjuster')]
      const { applyEntryMultiplier } = await import('../services/lib/entry_price_adjuster')
      
      // Spusť test
      const result = applyEntryMultiplier(testCase.entryPrice)
      const isMatch = Math.abs(result - testCase.expected) < 0.0001
      
      if (isMatch) {
        console.log(`✅ ${testCase.description}`)
        console.log(`   ${testCase.entryPrice} → ${result} (očekáváno: ${testCase.expected})`)
        passed++
      } else {
        console.log(`❌ ${testCase.description}`)
        console.log(`   ${testCase.entryPrice} → ${result} (očekáváno: ${testCase.expected})`)
        failed++
      }
    } catch (e: any) {
      console.log(`❌ ${testCase.description} - ERROR: ${e.message}`)
      failed++
    }
  }
  
  // Obnov původní config
  fs.writeFileSync(configPath, originalConfig, 'utf8')
  
  console.log('\n📊 Výsledky:')
  console.log(`   Passed: ${passed}/${testCases.length}`)
  console.log(`   Failed: ${failed}/${testCases.length}`)
  
  if (failed === 0) {
    console.log('\n✨ Všechny testy prošly!\n')
  } else {
    console.log('\n⚠️  Některé testy selhaly!\n')
    process.exit(1)
  }
}

// Testy pro validaci
async function testValidation() {
  console.log('\n🛡️  Validační testy\n')
  
  const configPath = path.join(process.cwd(), 'config', 'trading.json')
  const originalConfig = fs.readFileSync(configPath, 'utf8')
  const config = JSON.parse(originalConfig)
  
  const invalidCases = [
    { multiplier: 110.0, description: 'Příliš vysoký multiplier (110%)' },
    { multiplier: 90.0, description: 'Příliš nízký multiplier (90%)' },
  ]
  
  for (const testCase of invalidCases) {
    config.ENTRY_PRICE_MULTIPLIER = testCase.multiplier
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
    
    delete require.cache[require.resolve('../services/lib/entry_price_adjuster')]
    const { applyEntryMultiplier } = await import('../services/lib/entry_price_adjuster')
    
    const result = applyEntryMultiplier(100.0)
    
    // Mělo by vrátit původní hodnotu (100) kvůli fallbacku
    if (result === 100.0) {
      console.log(`✅ ${testCase.description} - správně odmítnuto (fallback na 100)`)
    } else {
      console.log(`❌ ${testCase.description} - validace selhala! Vráceno: ${result}`)
    }
  }
  
  // Obnov původní config
  fs.writeFileSync(configPath, originalConfig, 'utf8')
  console.log('')
}

// Spusť všechny testy
runTests().then(() => testValidation()).catch(console.error)

