import { startChild, sleep, defineSignal, defineQuery, setHandler } from '@temporalio/workflow'

export type AutoCopyItem = {
  symbol: string
  side: 'LONG' | 'SHORT'
  strategy: 'conservative' | 'aggressive'
  amountUsd: number
  leverage: number
  orderType?: 'market' | 'limit' | 'stop' | 'stop_limit'
  entry: number
  sl: number
  tp: number
  riskApproved?: boolean
  skipAi?: boolean
}

export type AutoCopyParams = {
  items: AutoCopyItem[]
  intervalMinutes: number
  maxRounds?: number | null
  openaiQueue: string
  binanceQueue: string
}

type RoundResult = { symbol: string; ok: boolean; workflowId?: string; error?: string }
type AutoCopyStatus = { round: number; paused: boolean; nextAt: string | null; lastResults: RoundResult[] }

const pauseSignal = defineSignal('pause')
const resumeSignal = defineSignal('resume')
const cancelSignal = defineSignal('cancel')
const statusQuery = defineQuery<AutoCopyStatus>('status')

export async function AutoCopyWorkflow(params: AutoCopyParams): Promise<void> {
  const items = Array.isArray(params?.items) ? params.items : []
  if (items.length === 0) return
  const intervalMs = Math.max(1, Math.floor(params?.intervalMinutes || 1)) * 60 * 1000
  let remaining = params?.maxRounds == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(params.maxRounds))
  if (!params.openaiQueue || !params.binanceQueue) {
    throw new Error('queue_names_missing')
  }
  let paused = false
  let cancelled = false
  let round = 0
  let nextAt: string | null = null
  let lastResults: RoundResult[] = []

  setHandler(pauseSignal, () => { paused = true })
  setHandler(resumeSignal, () => { paused = false })
  setHandler(cancelSignal, () => { cancelled = true })
  setHandler(statusQuery, () => ({ round, paused, nextAt, lastResults }))

  while (!cancelled && remaining > 0) {
    // Calculate next run time if not first round
    if (round > 0 && !paused) {
      nextAt = new Date(Date.now() + intervalMs).toISOString()
      await sleep(intervalMs)
    }
    
    // Wait while paused
    while (paused && !cancelled) {
      nextAt = null
      await sleep(1000)
    }
    if (cancelled) break

    round += 1
    remaining = Number.isFinite(remaining) ? (remaining - 1) : remaining
    nextAt = null // Clear during active round

    // Start children in parallel for this round
    const children = await Promise.all(items.map(async (it) => {
      try {
        const handle = await startChild('EntryAssistantWorkflow', {
          // use parent taskQueue (orchestrator); activities inside child route to io-openai/io-binance
          args: [{
            symbol: it.symbol,
            side: it.side,
            strategy: it.strategy,
            amountUsd: it.amountUsd,
            leverage: it.leverage,
            orderType: it.orderType,
            entry: it.entry,
            sl: it.sl,
            tp: it.tp,
            riskApproved: it.riskApproved ?? true,
            skipAi: it.skipAi ?? true,
            openaiQueue: params.openaiQueue,
            binanceQueue: params.binanceQueue
          }]
        })
        return { symbol: it.symbol, handle }
      } catch (e: any) {
        return { symbol: it.symbol, error: String(e?.message || e) }
      }
    }))

    // Await results best-effort
    lastResults = []
    for (const ch of children) {
      if ((ch as any).error) {
        lastResults.push({ symbol: ch.symbol, ok: false, error: (ch as any).error })
        continue
      }
      try {
        const handle = (ch as any).handle as ReturnType<typeof startChild>
        await (handle as any).result()
        lastResults.push({ symbol: ch.symbol, ok: true, workflowId: (handle as any).workflowId })
      } catch (e: any) {
        lastResults.push({ symbol: ch.symbol, ok: false, error: String(e?.message || e) })
      }
    }

    // Continue to next round
  }
}

export const AutoCopy = { signals: { pause: pauseSignal, resume: resumeSignal, cancel: cancelSignal }, queries: { status: statusQuery } }


