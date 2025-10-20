#!/usr/bin/env tsx
// Rychlý test entry multiplieru v produkčním kontextu

import { applyEntryMultiplier, loadEntryMultiplier } from '../services/lib/entry_price_adjuster'

console.log('=== QUICK MULTIPLIER TEST ===\n')

// 1. Test načtení z configu
const multiplier = loadEntryMultiplier()
console.log(`✓ Multiplier z configu: ${multiplier}%`)

// 2. Test aplikace
const testPrice = 100.0
const adjusted = applyEntryMultiplier(testPrice)
console.log(`✓ Test cena: ${testPrice} → ${adjusted}`)
console.log(`✓ Změna: ${((adjusted / testPrice - 1) * 100).toFixed(3)}%`)

// 3. Test s workflow override (mělo by být 100%)
const workflowAdjusted = applyEntryMultiplier(testPrice, undefined, undefined, 100.0)
console.log(`✓ Workflow test (override 100%): ${testPrice} → ${workflowAdjusted}`)

console.log('\n=== TEST OK ===')
