import path from 'node:path'

export const PROMPTS_SIDE: 'SHORT' = (() => {
  const side = String(process.env.TRADE_SIDE || '').toUpperCase()
  if (side && side !== 'SHORT') {
    throw new Error('prompt side mismatch: TRADE_SIDE must be SHORT for this service')
  }
  return 'SHORT'
})()

export function resolvePromptPathShort(relativeFileName: string): string {
  const p = path.resolve(`prompts/short/${relativeFileName}`)
  if (!/\bprompts\/short\//.test(p.replaceAll('\\', '/'))) {
    throw new Error('prompt side mismatch: attempted to access non-short prompt path')
  }
  return p
}


