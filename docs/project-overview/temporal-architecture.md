## Temporal Architecture (Headless Orchestration)

### Goals & Principles
- **Robust orchestration**: deterministické Workflows, side‑effecty pouze v Activities.
- **Maximální paralelismus řízeně**: per‑symbol serializace, per‑queue limity, žádné race conditions.
- **Exactly‑once/idempotence**: deterministické `clientOrderId`, deduplikace přes DB klíče.
- **No fallbacks**: nikdy neaktivovat „zjednodušené“ módy. Při chybě pouze explicitní retry/backoff nebo kompenzace.
- **No cache for market/positions**: data vždy čerstvá z Binance; UI zobrazuje 1:1 Binance pozice.

### Topology & Infra
- **Temporal Cloud** (doporučeno) nebo self‑host; 1+ Temporal Workers (Node.js) běžící headless (PM2/Docker/systemd).
- **Postgres** jako auditní „system of record“ (append‑only tabulky) pro `trades`, `orders`, `fills`, `lifecycle_events`, `pnl_snapshots`.
- **UI** je volitelné: Queries/Signals do Workflows; Temporal Web pro observabilitu.

### Task Queues & Concurrency (baseline)
- `trader` (hlavní orchestrace/workflows)
- `io-binance` (aktivity pro Binance, s rate‑limit guardem)
- `io-openai` (aktivity pro OpenAI, s rozpočtovými guardy)
- `compute` (výpočty a feature extraction)

Startovní limity: `io-binance: 32`, `io-openai: 16–24`, `compute: 8–16`. Tuning dle reálných limitů a nákladů.

### Workflows (long‑running)
- `StrategyUpdaterWorkflow` (cron 5m)
  - Vstup: žádný nebo profil (A/B/C). Výstup: emit signály/spuštění `TradeLifecycleWorkflow`.
  - Durable timers, backoff při chybách, žádné fallbacky.
- `TradeLifecycleWorkflow` (per obchod)
  - Fáze: entry → čekání na fill → place SL/TP (multi‑TP) → monitor → exit → PnL finalize.
  - Jediná pravda o stavu otevřeného obchodu, řídí watchers.
- `ProfitTakerWorkflow`
  - Samostatná správa výstupů/TP/SL, pokud se oddělí od lifecycle.
- `DailyPnlReportWorkflow`
  - Denní uzávěrka pomocí durable timerů + zápis do DB a report.

### Activities (I/O & side‑effects)
- `binance.activities`:
  - `placeOrder`, `cancelOrder`, `amendOrder`, `ensureLeverage`, `ensureHedge/OneWay`, `fetchPositions`, `fetchTicker`, `fetchKlines`.
  - Idempotence přes deterministický `newClientOrderId` a audit do Postgres.
- `openai.activities`:
  - `runAggressiveEntry`, `runConservativeEntry`, `runStrategyUpdater` (podle aktuálních promptů v `prompts/`).
- `data.activities`:
  - Čerstvá tržní data (bez cache), výpočty mohou běžet v `compute` queue.

### Idempotence & Exactly‑once
- `clientOrderId = wf:${workflowId}:leg:${legId}:att:${attempt}` (krátit dle limitu burzy; pro Binance <= 36 znaků variantu zkrátit hashováním).
- DB unikátní klíče: `client_order_id` a/kombinace `(workflow_id, leg_id, attempt)`.
- „Unknown result“ po timeoutu řešit read‑after‑write (query order) a deduplikací.

### Rate Limiting & Backpressure
- Token‑bucket guard v `io-binance` aktivitách dle Binance váh.
- Konfigurováno env proměnnými (např. `BINANCE_WEIGHT_PER_MINUTE`). Při vyčerpání se čeká; žádné fallback módy.
- `io-openai` queue s pevným paralelismem a rozpočtovým guardem (počty volání/interval). Žádné fallbacky.

### Signals & Queries
- Signals (příklady): `PauseSymbol`, `ResumeSymbol`, `ExitNow`, `UpdateSL`, `UpdateTPs`.
- Queries: `status`, `remainingTPs`, `lastError`, `openedAt`.

### Headless Operation
- Workers běží bez prohlížeče. UI je jen nadstavba (Temporal Web + vlastní UI pro Queries/Signals).

### Observability & Logging
- Temporal Web = historie běhů, retry důvody, graf závislostí.
- Aplikace loguje do Postgres (audit) + strukturované logy (pino). Soubory v `runtime/` jen pro DEV.

### Migration Plan (phased)
1) PoC: `TradeLifecycleWorkflow` pro jeden symbol + Binance activities + DB audit.
2) Přidat `StrategyUpdaterWorkflow` (5m) a napojit na stávající decision logiku (prompts z `prompts/`).
3) Vytáhnout TP/SL management a denní report do separátních workflows.
4) Rozdělit task queues, doladit concurrency/rate‑limits, přidat Signals/Queries.
5) UI integrace (volitelné): ovládání přes Queries/Signals.

### Env & Run
- Povinné proměnné: `TEMPORAL_ADDRESS` (např. `localhost:7233` nebo cloud endpoint), `TASK_QUEUE` (např. `trader`).
- Start workeru: `npm run dev:temporal:worker`.
- Lokální paralelní běh backend + worker: `npm run dev:temporal`.

### PoC run – TradeLifecycleWorkflow
1) Spusť worker: `TEMPORAL_ADDRESS=localhost:7233 TASK_QUEUE=trader npm run dev:temporal:worker`
2) Spusť PoC workflow (v jiném shellu):
   - Příklad LIMIT LONG:
     `SYMBOL=BTCUSDT SIDE=LONG NOTIONAL_USD=50 LEVERAGE=5 ENTRY_TYPE=LIMIT ENTRY_PRICE=60000 SL=59000 TP=60500 TEMPORAL_ADDRESS=localhost:7233 TASK_QUEUE=trader npm run wf:start:trade`
   - Příklad MARKET LONG:
     `SYMBOL=BTCUSDT SIDE=LONG NOTIONAL_USD=50 LEVERAGE=5 ENTRY_TYPE=MARKET SL=1 TP=999999 TEMPORAL_ADDRESS=localhost:7233 TASK_QUEUE=trader npm run wf:start:trade`

Workflow provede: align leverage → výpočet qty → ENTRY → krátké čekání → založení SL (CP + RO pokud existuje pozice) a TP MARKET → monitoring až do uzavření pozice. Žádné fallbacky, žádná cache tržních dat/pozic.

### StrategyUpdater – runOnce a 5m loop
- Jednorázové spuštění (runOnce=true):
  `TEMPORAL_ADDRESS=127.0.0.1:7233 TASK_QUEUE=trader SU_RUN_ONCE=true npm run wf:start:su`
- Periodický běh (durable 5 min smyčka): spusť bez `SU_RUN_ONCE`, worker udrží timers:
  `TEMPORAL_ADDRESS=127.0.0.1:7233 TASK_QUEUE=trader SU_RUN_ONCE=false npm run wf:start:su`

### Data Model (DDL)
Viz `docs/project-overview/temporal-ddl.sql`.

### Migration – practical steps
1) Zřídit Temporal (Cloud nebo lokálně) a Postgres instanci.
2) Aplikovat DDL do Postgres.
3) Spustit Temporal worker (`npm run dev:temporal:worker`) s `TASK_QUEUE=trader`.
4) Připravit Activities: binance/openai/data (využít naše existující moduly bez změny chování).
5) Zabalit první symbol do `TradeLifecycleWorkflow` (PoC), bez změn UI.
6) Připojit `StrategyUpdaterWorkflow` (cron 5m) a napojit prompts dle `prompts/`.

### Security & Secrets
- API klíče v env (OpenAI, Binance), bez zápisu do logů. Rotace klíčů přes standardní mechanismus.

### Invariants
- Žádné fallback módy.
- Žádné cache pro market/positions (vždy čerstvá data z Binance).
- SL monotónní (nesnižuje se), TP před magnety/EMA/VWAP dle promptů.

