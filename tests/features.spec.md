# Features – Akceptační scénáře

## 1) Breadth v rozsahu 0–100
- Načti `MarketRawSnapshot` z M1 exportu
- Spočti `FeaturesSnapshot`
- Ověř, že `breadth.pct_above_EMA50_H1` ∈ [0,100]

## 2) EMA pořadí je vždy z definovaného enumu
- Pro každý řádek `universe`:
  - `ema_order_H1` i `ema_order_M15` je jeden z: `20>50>200`, `20>200>50`, `50>20>200`, `50>200>20`, `200>20>50`, `200>50>20`

## 3) BTC/ETH flags
- `btc.flags.H1_above_VWAP` odpovídá `close_H1` vs `VWAP_H1`
- `btc.flags.H4_ema50_gt_200` odpovídá `ema50_H4 > ema200_H4`

## 4) Bez NaN/Infinity a velikost ≤ 200 kB
- Serializuj JSON a ověř, že neobsahuje `NaN` a má velikost ≤ 200 kB

## 5) Výkon
- Změř `performance.now()` před/po compute → do 100 ms pro ~30–40 symbolů

