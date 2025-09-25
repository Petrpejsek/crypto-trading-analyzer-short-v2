# Perf Sprint – Stabilizace `symbols ≥ 30`

## Stav dnes
- `duration_ms`: 1.1–1.9 s (OK)
- `featuresMs`: 2–4 ms (OK)
- `sizes`: OK
- **symbols**: ~24 (nestabilní H1 u altů)

## Hypotéza problému
- H1 u části altů není dostupná v čase snapshotu (WS start pozdě / REST backfill nedostatečný).
- WS/TTL cache snižuje latenci, ale pokrytí H1 u TopN altů kolísá.

## Cíl
- **Stabilně `symbols ≥ 30`** (BTC/ETH = H4+H1, alts = H1) při `duration_ms ≤ 2000 ms`.

## Návrh řešení (malé, konkrétní)
- WS prewarm pro TopN H1 při startu serveru (setAltUniverse(topN) + krátké warm window).
- Garantovaný REST backfill **N=2–3** H1 barů pro alty bez cache.
- Telemetrie `drop:*:alt:*:noH1` → agregace a alert, ať vidíme opakující se symboly.

## Akceptační kritéria
- 3 po sobě jdoucí QA běhy: `duration_ms ≤ 2000`, `symbols ≥ 30`, žádné NaN/Infinity, sizes OK.

## Úkoly
- [ ] WS prewarm TopN H1 při startu (bez vlivu na logiku features/signals).
- [ ] Backfill 2–3 H1 bary pro chybějící alty (merge podle openTime).
- [ ] Log & report `drop:*:alt:*:noH1` (počty + unikátní symboly).
- [ ] QA série (3×) a zápis výsledků do README.

## RUNBOOK – Candidates (LEAN)

- Aktuální LEAN topK: 8 (profiles.lean.topK)
- Gates (LEAN):
  - min_avg_trade_usdt = 12
  - min_body_ratio_m15 = 0.44
  - max_upper_wick_ratio_m15 = 0.50
  - hard_gates.atr_pct_h1.min = 1.00
- Pokud se objeví moc low-liquidity picků: zvyš min_avg_trade_usdt na 15 a znovu spusť QA runner `npm run -s qa:profiles:fresh`.

