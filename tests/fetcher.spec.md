# Public Fetcher – Akceptační scénáře

## 1. Základní snapshot
- Akce: Kliknout na "Run"
- Očekávání:
  - `feeds_ok = true`
  - `latency_ms < 800`
  - `universe.length = 50`
  - `btc.klines` a `eth.klines` obsahují H4/H1/M15, každé má 150 svíček
  - `depth1pct_usd` a `spread_bps` vyplněné pro ≥ 90 % symbolů
  - `oi_now` a z `oi_hist` lze spočítat Δ 1h/4h
  - Velikost snapshotu ≤ 2.5 MB

## 2. Stárnutí dat (simulace)
- Akce: Zpomalit síť/čekat až data budou starší než 120s
- Očekávání:
  - `feeds_ok = false`
  - `data_warnings` obsahuje důvod

## 3. Edge-cases
- Chybějící symbol v `exchangeInfo` → symbol vyřazen, `data_warnings` obsahuje důvod
- Překročení `rate-limit` → backoff/retry, snapshot se dokončí
- Špatně formátované číslo → je převedeno na `number` nebo symbol vyřazen s varováním

