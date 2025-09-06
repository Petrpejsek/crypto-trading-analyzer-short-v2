## Konfigurace (config/*.json)

### fetcher.json
- `timeoutMs`, `retry` – globální retry politika pro REST volání
- `concurrency` – paralelismus při tahání klines / side-dat
- `universe.topN` – default počet altů (plus BTC/ETH)
- `universe.strategy` – `gainers|volume` (výchozí preferováno `gainers`)
- `staleThresholdSec` – stáří dat pro validaci `feeds_ok`
- `depthMode` – `bookTicker+depth` pro spread/liquidity výpočet

### trading.json
- `EXIT_WORKING_TYPE`: `MARK_PRICE` doporučeno
- `TP_MODE`: `MARKET_PREENTRY` nebo `LIMIT_ON_FILL`
- `RAW_PASSTHROUGH`: `true` – neposouvat ceny v enginu, posílat přesně UI hodnoty
- `DISABLE_LIMIT_TP`: `false` – ponechat limit TP politiku
- `SAFE_MODE_LONG_ONLY`: `false` – když `true`, zapne sekvenční LONG-only whitelist
- `PENDING_*` – časování/sweeper parametry

### decider.json, signals.json, candidates.json
- Řídí M3/M4/M7 pipeline (GPT modely, limity, filtry). UI čte tyto hodnoty a posílá je na backend.

### Schémata (schemas/*.json)
- Slouží pro validace promptů a struktur – držte je konzistentní s implementacemi v `services/decider/*` a `server/index.ts`.



