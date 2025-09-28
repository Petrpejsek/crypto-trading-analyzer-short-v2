module.exports = {
  apps: [
    {
      name: 'trader-backend',
      script: 'server/index.ts',
      interpreter: './node_modules/.bin/tsx',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: '8888'
      }
    },
    {
      name: 'trader-worker',
      script: 'temporal/worker.ts',
      interpreter: './node_modules/.bin/tsx',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Povinné: poskytnout tyto proměnné v produkčním prostředí (bez defaultů)
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
        TASK_QUEUE: process.env.TASK_QUEUE,
        TASK_QUEUE_OPENAI: process.env.TASK_QUEUE_OPENAI,
        TASK_QUEUE_BINANCE: process.env.TASK_QUEUE_BINANCE,
        // OpenAI credentials (propagované z host env)
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_ORG_ID: process.env.OPENAI_ORG_ID,
        OPENAI_PROJECT: process.env.OPENAI_PROJECT
      }
    }
  ]
}


