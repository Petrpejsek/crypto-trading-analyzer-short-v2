/**
 * Export overlay promptů do registry (prompts/*.md)
 * 
 * Použití:
 *   NODE_ENV=development tsx scripts/export_prompts_to_registry.ts
 * 
 * Co dělá:
 *   1. Načte všechny overlay prompty z runtime/prompts/dev/_meta.json
 *   2. Exportuje je do prompts/*.md
 *   3. Provede atomic write + verifikaci
 *   4. Po exportu COMMITNI prompts/*.md!
 */

import { exportAllOverlaysToRegistry } from '../services/lib/dev_prompts.js'

async function main() {
  console.log('📤 Export overlay promptů → registry\n')
  
  // Check dev mode
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Tento script je pouze pro dev mód')
    console.error('   Nastav: NODE_ENV=development')
    process.exit(1)
  }
  
  try {
    const results = exportAllOverlaysToRegistry()
    
    const success = results.filter(r => r.exported)
    const failed = results.filter(r => !r.exported)
    
    console.log('━'.repeat(60))
    console.log('📊 Výsledky exportu')
    console.log('━'.repeat(60))
    console.log()
    
    if (success.length > 0) {
      console.log(`✅ Úspěšně exportováno: ${success.length}`)
      for (const r of success) {
        console.log(`   ✓ ${r.assistantKey}`)
        console.log(`     → ${r.path}`)
        console.log(`     → ${r.sha256?.slice(0, 16)}...`)
      }
      console.log()
    }
    
    if (failed.length > 0) {
      console.log(`❌ Selhalo: ${failed.length}`)
      for (const r of failed) {
        console.log(`   ✗ ${r.assistantKey}`)
        console.log(`     → ${r.error}`)
      }
      console.log()
    }
    
    if (results.length === 0) {
      console.log('⚠️  Žádné overlay prompty k exportu')
      console.log('   Vytvoř je nejdříve v UI (📝 Prompts)')
      console.log()
      process.exit(0)
    }
    
    console.log('━'.repeat(60))
    console.log('✅ Export dokončen')
    console.log('━'.repeat(60))
    console.log()
    console.log('🚨 DŮLEŽITÉ: Další kroky')
    console.log()
    console.log('   1. Zkontroluj změny:')
    console.log('      git diff prompts/')
    console.log()
    console.log('   2. Commitni změny:')
    console.log('      git add prompts/')
    console.log('      git commit -m "chore: update prompts from dev overlay"')
    console.log()
    console.log('   3. Push:')
    console.log('      git push')
    console.log()
    console.log('   4. Deploy na produkci')
    console.log('      → Prod použije nové prompts/*.md')
    console.log()
    
    if (failed.length > 0) {
      console.error('⚠️  Některé exporty selhaly - zkontroluj chyby výše')
      process.exit(1)
    }
    
  } catch (err: any) {
    console.error('❌ Export selhal:', err?.message || err)
    process.exit(1)
  }
}

main()
