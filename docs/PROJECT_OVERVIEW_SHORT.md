Basic Info

- repo: /Users/petrliesner/trader-short-v2
- branch: main
- HEAD: 7db7f18

Runtime

- PORT: 3081
- PM2 apps:
```
│ 0  │ trader-short-backend    │ default     │ 1.0.0   │ fork    │ 94211    │ 11m    │ 1    │ online    │ 0%       │ 37.1mb   │ petrlie… │ disabled │
│ 1  │ trader-short-worker     │ default     │ 1.0.0   │ fork    │ 12496    │ 0s     │ 726  │ online    │ 0%       │ 38.3mb   │ petrlie… │ disabled │
```
- health: {"ok":true}
- Temporal (from logs):
```

```

Prompts

- files:
- SNAPSHOT_20250927T1701.md
- entry_risk_manager.md
- entry_strategy.md
- entry_strategy_aggressive.md
- entry_strategy_conservative.md
- entry_updater.md
- final_picker.md
- hot_screener.md
- hot_screener_short.md
- market_decider.md
- profit_taker.md
- registry.json
- strategy_updater.md
- top_up_executor.md
- registry version: "version": "20250927T1701"
- checksum count: 12
- snapshot: 20250927T1701

Guards

- required ENV: TRADE_SIDE=SHORT, PORT=3081 (prod), TEMPORAL_NAMESPACE=* -short, TASK_QUEUE*, TASK_QUEUE_OPENAI, TASK_QUEUE_BINANCE end -short
- side-lock: enforced at runtime (throw on mismatch)

Deploy

- runbook: docs/RUNBOOK_SHORT.md
- last safety tag: safety-pre-prompts-restore-short-2025-09-27-1845
- rollback: git reset --hard <safety-tag> && pm2 reload ecosystem.short.config.cjs

Monitoring

- grep TRADE_SIDE/PROMPTS_SIDE: pm2 logs trader-short-backend --lines 200 --nostream | grep -E 'TRADE_SIDE=|PROMPTS_SIDE='
- grep Temporal: pm2 logs trader-short-worker --lines 200 --nostream | grep -E 'TEMPORAL_NAMESPACE|trader=|openai=|binance='
- health: curl -sS http://127.0.0.1:3081/api/health
