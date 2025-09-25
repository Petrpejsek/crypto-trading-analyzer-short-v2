import 'dotenv/config'
import { Connection, Client } from '@temporalio/client'

async function main() {
  const address = process.env.TEMPORAL_ADDRESS
  if (!address) throw new Error('TEMPORAL_ADDRESS is required')
  const taskQueue = process.env.TASK_QUEUE || 'trader'

  const connection = await Connection.connect({ address })
  const client = new Client({ connection })

  const profile = (process.env.SU_PROFILE as any) || 'A'
  const runOnce = String(process.env.SU_RUN_ONCE || 'true') === 'true'
  const wfId = `su_${Date.now()}`
  const handle = await client.workflow.start('StrategyUpdaterWorkflow', {
    taskQueue,
    workflowId: wfId,
    args: [{ profile, runOnce, openaiQueue: String(process.env.TASK_QUEUE_OPENAI || '') }]
  })

  console.log('[WF_SU_STARTED]', { id: handle.workflowId })
  await handle.result()
  console.log('[WF_SU_COMPLETED]', { id: handle.workflowId })
}

main().catch((err) => { console.error(err); process.exit(1) })


