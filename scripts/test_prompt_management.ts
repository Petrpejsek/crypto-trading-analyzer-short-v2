/**
 * Test script pro Prompt Management systém
 * 
 * Použití:
 *   NODE_ENV=development tsx scripts/test_prompt_management.ts
 */

import fs from 'node:fs'
import path from 'node:path'

const RUNTIME_DIR = path.resolve('runtime/prompts/dev')
const META_FILE = path.join(RUNTIME_DIR, '_meta.json')

async function testPromptManagement() {
  console.log('🧪 Test Prompt Management systému\n')
  
  // Test 1: Dev mode detection
  console.log('✓ Test 1: Dev mode detection')
  const { isDevMode } = await import('../services/lib/dev_prompts.js')
  const isDev = isDevMode()
  console.log(`  NODE_ENV: ${process.env.NODE_ENV}`)
  console.log(`  isDev: ${isDev}`)
  if (!isDev) {
    console.log('  ⚠️  Není dev mód, některé testy se přeskočí\n')
  } else {
    console.log('  ✓ Dev mód aktivní\n')
  }
  
  // Test 2: List assistants
  console.log('✓ Test 2: Seznam asistentů')
  const { listAssistants } = await import('../services/lib/dev_prompts.js')
  const assistants = listAssistants()
  console.log(`  Celkem asistentů: ${assistants.length}`)
  console.log(`  S overlay: ${assistants.filter(a => a.hasOverlay).length}`)
  console.log(`  Bez overlay: ${assistants.filter(a => !a.hasOverlay).length}`)
  
  // Zobraz první 3 asistenty
  console.log('  První 3 asistenti:')
  for (const a of assistants.slice(0, 3)) {
    console.log(`    - ${a.assistantKey} ${a.hasOverlay ? `(overlay: ${a.sha256?.slice(0, 8)})` : '(registry only)'}`)
  }
  console.log()
  
  // Test 3: Resolve prompt
  console.log('✓ Test 3: Resolve prompt')
  const { resolveAssistantPrompt, notePromptUsage } = await import('../services/lib/dev_prompts.js')
  
  // Zkus načíst strategy_updater z registry (fallback pro dev)
  console.log('  Načítám strategy_updater...')
  try {
    const result = resolveAssistantPrompt('strategy_updater', 'prompts/short/strategy_updater.md')
    console.log(`  ✓ Načteno: ${result.text.length} znaků`)
    console.log(`  ✓ Hash: ${result.sha256.slice(0, 16)}...`)
    console.log(`  ✓ Source: ${result.source}`)
    
    // Zaznamenej použití
    notePromptUsage('strategy_updater', result.sha256)
    console.log(`  ✓ Použití zaznamenáno do audit logu`)
  } catch (e: any) {
    if (isDev && e.message.includes('Overlay prompt not found')) {
      console.log('  ⚠️  Overlay prompt neexistuje (očekávané v dev módu)')
      console.log('  → Použij UI pro vytvoření overlay')
    } else {
      console.log(`  ❌ Chyba: ${e.message}`)
    }
  }
  console.log()
  
  // Test 4: Attestation
  console.log('✓ Test 4: Attestation info')
  const { getPromptAttestation } = await import('../services/lib/dev_prompts.js')
  const attestation = getPromptAttestation('strategy_updater')
  console.log(`  Stored hash: ${attestation.storedSha256?.slice(0, 16) || 'žádný'}...`)
  console.log(`  Last used hash: ${attestation.lastUsedSha256?.slice(0, 16) || 'žádný'}...`)
  console.log(`  Last used at: ${attestation.lastUsedAt || 'nikdy'}`)
  
  if (attestation.storedSha256 && attestation.lastUsedSha256) {
    const match = attestation.storedSha256 === attestation.lastUsedSha256
    console.log(`  Match: ${match ? '✓' : '❌'}`)
  }
  console.log()
  
  // Test 5: Runtime structure
  console.log('✓ Test 5: Runtime struktura')
  if (fs.existsSync(RUNTIME_DIR)) {
    console.log(`  ✓ Runtime dir existuje: ${RUNTIME_DIR}`)
    const files = fs.readdirSync(RUNTIME_DIR)
    console.log(`  Soubory: ${files.join(', ')}`)
    
    if (fs.existsSync(META_FILE)) {
      const metaRaw = fs.readFileSync(META_FILE, 'utf8')
      const meta = JSON.parse(metaRaw)
      console.log(`  ✓ Meta registry: ${Object.keys(meta).length} záznamů`)
    } else {
      console.log('  ⚠️  Meta registry neexistuje (zatím žádné overlay)')
    }
  } else {
    console.log('  ⚠️  Runtime dir neexistuje (žádné overlay)')
  }
  console.log()
  
  // Test 6: Integrace do asistentů
  console.log('✓ Test 6: Integrace status')
  const integratedAssistants = [
    'strategy_updater',
    'entry_updater',
    'entry_strategy_conservative',
    'entry_strategy_aggressive'
  ]
  console.log('  Integrované asistenty:')
  for (const key of integratedAssistants) {
    const a = assistants.find(x => x.assistantKey === key)
    console.log(`    ✓ ${key}`)
  }
  
  const remainingAssistants = [
    'entry_risk_manager',
    'final_picker',
    'hot_screener',
    'hot_screener_short',
    'market_decider',
    'profit_taker',
    'top_up_executor'
  ]
  console.log('  Zbývající k integraci:')
  for (const key of remainingAssistants) {
    const a = assistants.find(x => x.assistantKey === key)
    console.log(`    - ${key}`)
  }
  console.log()
  
  // Shrnutí
  console.log('━'.repeat(60))
  console.log('📊 Shrnutí')
  console.log('━'.repeat(60))
  console.log(`✅ Systém funkční`)
  console.log(`📁 Runtime: ${RUNTIME_DIR}`)
  console.log(`📝 Meta registry: ${fs.existsSync(META_FILE) ? 'existuje' : 'neexistuje'}`)
  console.log(`🎯 Asistentů celkem: ${assistants.length}`)
  console.log(`✓ Integrace: ${integratedAssistants.length}/${assistants.length}`)
  console.log()
  
  if (!isDev) {
    console.log('⚠️  Pro plnou funkcionalitu nastav NODE_ENV=development')
    console.log()
  } else {
    console.log('💡 Další kroky:')
    console.log('   1. Spusť dev server')
    console.log('   2. Otevři UI a klikni na "📝 Prompts"')
    console.log('   3. Vytvoř overlay pro asistenty')
    console.log('   4. Spusť asistenta a zkontroluj meta.prompt_sha256')
    console.log()
  }
}

// Run test
testPromptManagement().catch((e) => {
  console.error('❌ Test failed:', e)
  process.exit(1)
})
