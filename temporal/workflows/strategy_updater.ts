import { defineSignal, setHandler, proxyActivities, sleep } from '@temporalio/workflow';
import type { Activities } from '../activities/types'

export const pauseSignal = defineSignal('PauseSymbol');
export const resumeSignal = defineSignal('ResumeSymbol');

export interface StrategyUpdaterParams { profile?: 'A' | 'B' | 'C'; runOnce?: boolean; openaiQueue: string }

function makeActivities(openaiQueue: string) {
  return proxyActivities<Activities>({ startToCloseTimeout: '4 minutes', taskQueue: openaiQueue })
}

// Stub workflow (deterministic shell). Implementace přijde následně.
export async function StrategyUpdaterWorkflow(params: StrategyUpdaterParams): Promise<void> {
  if (!params.openaiQueue) throw new Error('openaiQueue missing')
  const a = makeActivities(params.openaiQueue)
  let paused = false
  setHandler(pauseSignal, () => { paused = true })
  setHandler(resumeSignal, () => { paused = false })

  const intervalMs = 5 * 60 * 1000

  const runOnce = params?.runOnce === true
  do {
    if (!paused) {
      await a.suProcessDueUpdates()
    }
    if (runOnce) break
    await sleep(intervalMs)
  } while (true)
}


