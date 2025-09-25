## Architektura a adresářová struktura

### High-level moduly
- `server/`: HTTP server (Node http) – statický výdej `dist/`, REST API, řízení batch mutexu, audit, throttling, backoff. Integrace user-data WS přes `services/exchange/binance/userDataWs`.
- `services/`: aplikační logika (trading engine, decider, fetcher, features, atd.)
- `src/`: frontend (React + Vite), UI pro řízení a přehled stavů (Orders, Positions, Hot Screener, Entry, Final Picker)
- `config/`: runtime konfigurace (fetcher, decider, trading, signals, candidates)
- `schemas/`: JSON schémata pro validace (prompty, vstupy/ výstupy)
- `scripts/`: util/QA skripty

### Klíčové běhové toky
- Market data snapshot: `server/fetcher/binance.ts` → REST-only pull (klines, ticker, OI, funding, orderbook) → `buildMarketRawSnapshot()`
- Decision/GPT: `services/decider/*` volá OpenAI (při `DECIDER_MODE=gpt`) nebo lokální rules – endpointy `/api/decide`, `/api/final_picker`, `/api/hot_screener`, `/api/entry_strategy`
- Trading engine: `/api/place_orders` → `services/trading/binance_futures.executeHotTradingOrders()` (V3 batch 2s) → Binance Futures REST
- User-data WS: `services/exchange/binance/userDataWs` udržuje in-memory snapshot pozic a otevřených objednávek pro `/api/orders_console` a audit
- Rate limits diagnostika: `server/lib/rateLimits.ts` – centralizovaný log hlaviček a chyb, snapshot přes `/api/limits`

### Frontend tok (zestručněně)
- `src/ui/App.tsx` orchestruje běh: snapshot → features → decision → hot screener → entry analysis → prepare orders → `/api/place_orders`
- `src/ui/components/OrdersPanel.tsx` zobrazuje pozice, otevřené objednávky a waiting TP, volá `/api/orders_console`, řízené rušení, flatten, backoff UI

### Důležitá pravidla a zásady
- Žádné tiché fallbacky (na UI i serveru). Pokud není WS snapshot ready, server vrací prázdné seznamy (200) bez REST seedování. Chyby se vrací explicitně.
- STRIKTNĚ 1:1 mezi UI hodnotami a trading enginem; sanitizace pouze pro validní tvary (žádné přepisování významu, kromě explicitních bezpečnostních pravidel).





