# Trader MVP Analyze → Signals (SHORT Instance)

MVP Analyze pipeline (M1–M4) is implemented:
- M1: Public Fetcher (Binance Futures)
- M2: Features (deterministic indicators)
- M3-mini: Rules-based Market Decision
- M4-mini: Rules-based Signals (1–3 setups)

## Quick Start

### 1. Setup Temporal Cluster (KRITICKÉ!)

⚠️ **SHORT instance MUSÍ používat ODDĚLENÝ Temporal cluster!**

```bash
# Start SHORT Temporal cluster (port 7500)
./temporal/start-short-cluster.sh

# Nebo Docker Compose
docker-compose -f deploy/compose.short-temporal.yml up -d
```

📖 **Detailní dokumentace izolace**: [TEMPORAL_ISOLATION.md](TEMPORAL_ISOLATION.md)

### 2. Konfigurace

```bash
# Zkopíruj vzorový config
cp env.SHORT.example .env.local

# Uprav dle potřeby (API klíče atd.)
# TEMPORAL_ADDRESS=127.0.0.1:7500 (NIKDY ne 7233/7234!)
# TEMPORAL_NAMESPACE=trader-short
```

### 3. Run (dev environment)

- `./dev.sh start` – spustí backend na :8888, frontend (Vite) na :4302 a Temporal worker s live code reload
- Aplikace: http://localhost:4302 (proxy na backend :8888)
- **CRITICAL**: Pro debugging/opravy kódu VŽDY používej `./dev.sh start` (DEV mode s live reload), NE `pm2 start ecosystem.short.config.cjs` (PRODUCTION mode bez reload)

QA:
- Export fixtures: `npm run export:m1m2`
- Run checks: `npm run qa:m2`

Status: MVP Analyze→Signals – DONE

### 4. Process Lock System 🔒

Aplikace používá **PID lock file systém** pro zabránění duplicitnímu běhu instancí:

**Automatická ochrana:**
- Backend a Worker automaticky vytváří lock files při startu (`runtime/locks/*.lock`)
- Pokud se pokusíš spustit duplicitní instanci → **HARD STOP** s explicitní chybou
- Lock se automaticky uvolní při ukončení (exit, SIGINT, SIGTERM, uncaughtException)
- Stale locks (mrtvé procesy) se automaticky odstraní

**Utility příkazy:**
```bash
# Kontrola aktivních locks
npm run locks:check
./dev.sh locks:check

# Vyčištění všech locks (neukončí procesy!)
npm run locks:clear

# Dev.sh automaticky čistí locks při stop/restart
./dev.sh stop
```

**Trade Side izolace:**
- SHORT instance → `backend.short.lock`, `worker.short.lock`
- LONG instance → `backend.long.lock`, `worker.long.lock`
- SHORT a LONG mohou běžet souběžně, ale duplicitní SHORT × SHORT není možné ✅

📖 **Detailní dokumentace**: [docs/PROCESS_LOCK_SYSTEM.md](docs/PROCESS_LOCK_SYSTEM.md)

## MVP Analyze→Signals – DEV freeze

- Pass: duration_ms ≈ 1.1–1.9 s, featuresMs 2–4 ms, sizes OK
- Fail (tolerováno v DEV): symbols = 24
  - Poznámka: "blokováno symboly – chybí H1 u altů; WS/TTL/backfill jen částečně pokrývá TopN"
- Akční bod (další sprint): Perf Sprint – stabilizovat symbols ≥ 30 (WS alt H1 prewarm + robustnější backfill a telemetrie drop:*:alt:*:noH1)


## M4 Signals – DEV OK

- QA_M4_GO: YES (schema valid, deterministic order, guards in place, setups≤3).
- Export: see `fixtures/signals/last_signals.json`.
- Notes: backend/UI unchanged per scope; future step – GPT Decider (M3) integration plan.

## Order Guards

To prevent Binance -2021 ("Order would immediately trigger."), exits are created in a simple and reliable way:

- workingType: always MARK_PRICE for SL and TP (and for guard checks).
- Default (simplest): Do NOT send exits before fill. As soon as ENTRY is filled (even partial), immediately create:
  - SL = STOP_MARKET, closePosition: true, reduceOnly: true
  - TP = TAKE_PROFIT_MARKET, closePosition: true, reduceOnly: true
- Optional pre-entry mode (flag PREENTRY_EXITS_ENABLED): when enabled, send pre-entry exits only if BOTH conditions pass:
  - LONG: tpStop > mark + 5*tickSize AND slStop < mark - 3*tickSize
  - SHORT: mirrored
  - If the guard fails, exits are created on fill (no pending loops).
- Validation: prices/qty are rounded to tickSize/stepSize; entry↔tp/sl relations are validated (LONG: tp>entry, sl<entry; SHORT mirrored).

Config (`config/trading.json`):

```json
{
  "EXIT_WORKING_TYPE": "MARK_PRICE",
  "PREENTRY_EXITS_ENABLED": false,
  "TP_PREENTRY_MIN_GAP_TICKS": 5,
  "SL_PREENTRY_MIN_GAP_TICKS": 3,
  "MIN_TP_TICKS": 2,
  "MIN_SL_TICKS": 2,
  "PENDING_WATCH_INTERVAL_MS": 500,
  "PENDING_MAX_WAIT_MS": 120000
}
```

Log lines (one-liners per decision):

```text
[EXIT_DECISION] { phase: "pre_fill"|"on_fill", symbol, side, entry, tp, sl, last, mark, workingType, decision: "send_exits_now"|"send_exits_on_fill", reason }
```

Examples of reasons: "preentry_guard_failed", "preentry_disabled", "post_fill_default".

## Production Deployment 🚀

### PM2 Produkční běh

Pro produkci používej PM2 s dedikovaným config souborem:

```bash
# Start SHORT instance (produkce)
pm2 start ecosystem.short.config.cjs

# Status
pm2 status
pm2 logs

# Restart
pm2 restart all
# nebo jednotlivě:
pm2 restart trader-short-backend
pm2 restart trader-short-worker

# Stop
pm2 stop all

# Vyčištění locks po stop
npm run locks:clear
```

**⚠️ DŮLEŽITÉ:**
- PM2 běží v **PRODUCTION** módu - změny kódu vyžadují restart (NE hot reload)
- Pro development VŽDY používej `./dev.sh start` (hot reload)
- Process lock systém chrání před duplicitními instancemi i při PM2

**PM2 config soubory:**
- `ecosystem.short.config.cjs` - SHORT instance (port 3081, namespace trader-short)
- `ecosystem.config.js` - LONG instance (port 8888, namespace trader-default)

### Další produkční dokumentace

- [docs/ops/PRODUCTION.md](docs/ops/PRODUCTION.md) - Detailní operations guide
- [DEPLOY_INSTRUCTIONS.md](DEPLOY_INSTRUCTIONS.md) - Deploy workflow

