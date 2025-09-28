# Trader MVP Analyze → Signals

MVP Analyze pipeline (M1–M4) is implemented:
- M1: Public Fetcher (Binance Futures)
- M2: Features (deterministic indicators)
- M3-mini: Rules-based Market Decision
- M4-mini: Rules-based Signals (1–3 setups)

Run (dev environment):
- `npm run start:dev` – spustí backend na :8888, frontend (Vite) na :4302 a Temporal worker
- Aplikace: http://localhost:4302 (proxy na backend :8888)

QA:
- Export fixtures: `npm run export:m1m2`
- Run checks: `npm run qa:m2`

Status: MVP Analyze→Signals – DONE

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

### Production overview
See docs/ops/PRODUCTION.md for production setup, deploy and ops.

## Production overview

See detailed operations and deployment guide at:

- docs/ops/PRODUCTION.md

