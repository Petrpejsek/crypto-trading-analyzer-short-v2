import { resolvePromptPathShort } from '../services/prompts/guard'

function shouldThrow(fn: () => any): boolean {
  try { fn(); return false } catch { return true }
}

function main() {
  process.env.TRADE_SIDE = 'SHORT'
  const ok = resolvePromptPathShort('entry_risk_manager.md')
  if (!ok.includes('prompts/short/')) {
    console.error('[TEST_FAIL] expected short path')
    process.exit(1)
  }
  const threw = shouldThrow(() => (resolvePromptPathShort('../long/entry.md' as any)))
  if (!threw) {
    console.error('[TEST_FAIL] expected guard to throw on cross-side path')
    process.exit(1)
  }
  console.log('[TEST_OK] prompt side guard')
}

main()


