# Losers Overheat Relief - Algoritmus výběru kandidátů

## 📋 Přehled

**Losers Overheat Relief** je speciální archetype pro výběr alt universe kandidátů, který identifikuje coiny s **přehřátým relief rally** po 24h ztrátách. Strategie hledá exhaustion bounce na losers a fade je do shortu.

---

## 🎯 Koncept

```
24h loser → Relief rally → Overheat (RSI 70+) → Fade setup
```

**Klíčová myšlenka:**
- Coin měl velkou ztrátu za 24h (`ret_24h < 0`)
- Následoval silný bounce nahoru (1h positive)
- Rally se přehřála (RSI M15 ≥ 70, RSI H1 ≥ 60)
- Price je nad fair value (VWAP + 0.5×ATR)
- EMA20.M15 výrazně nad EMA50.M15 → impuls vyčerpán
- EMA20.H1 ≈ EMA50.H1 → blízko exhaustion

---

## ✅ MUST HAVE Kritéria

Pro zařazení do `losers_overheat_relief` musí coin splnit **VŠECHNA** tato kritéria:

| # | Kritérium | Hodnota | Význam |
|---|-----------|---------|--------|
| 1 | `ret_24h_pct` | `< 0` | 24h loser (záporný return) |
| 2 | `RSI.m15` | `≥ 70` | Přehřátý krátkodobý sentiment |
| 3 | `RSI.h1` | `≥ 60` | Přehřátý střednědobý sentiment |
| 4 | `EMA20.m15 - EMA50.m15` | `≥ 0.5%` | Přepálený impuls |
| 5 | `Price > VWAP + 0.5×ATR` | TRUE | Cena nad férovou hodnotou |
| 6 | `volume_24h_usd` | `≥ 1M USD` | Vysoká likvidita |
| 7 | `ret_1h_pct` | `> 0` | Positive relief rally (1h momentum) |
| 8 | `abs(EMA20.h1 - EMA50.h1)` | `≤ 3%` | EMA convergence = exhaustion |

---

## ❌ GUARDRAILS (Vyřazovací kritéria)

Coin bude **vyřazen**, pokud splňuje některé z těchto podmínek:

| # | Kritérium | Hodnota | Důvod |
|---|-----------|---------|-------|
| 1 | `spread_bps` | `> 400` | Příliš široký spread |
| 2 | `volume_24h_usd` | `< 50k` | Ilikvidní trh |
| 3 | `price < ema20.m15` | TRUE | Obrat už proběhl, pozdě |
| 4 | `ret_1h < 0` | TRUE | Trh už padá, ne relief |

---

## 📊 Scoring Systém (0-100)

Každý kandidát dostane skóre podle **5 faktorů** s různými vahami:

### 1️⃣ RSI Přepálení (25% váha)

```typescript
rsiM15Score = (RSI.m15 - 70) / 30 * 100  // 70-100 → 0-100
rsiH1Bonus = (RSI.h1 - 60) / 40 * 20     // +20 bonus max
finalRSIScore = min(100, rsiM15Score + rsiH1Bonus)
```

**Interpretace:**
- RSI.m15 = 70 → 0 bodů
- RSI.m15 = 85 → 50 bodů
- RSI.m15 = 100 → 100 bodů
- RSI.h1 ≥ 60 → extra bonus

---

### 2️⃣ Vzdálenost od VWAP/EMA (25% váha)

```typescript
vwapDist = (Price - VWAP) / ATR
distanceScore = (vwapDist - 0.5) / 1.0 * 100  // 0.5-1.5 ATR → 0-100

emaSpread = (EMA20.m15 - EMA50.m15) / EMA50.m15 * 100
emaBonus = min(30, emaSpread * 10)

finalDistanceScore = min(100, distanceScore + emaBonus)
```

**Interpretace:**
- Price = VWAP + 0.5×ATR → 0 bodů (minimum)
- Price = VWAP + 1.0×ATR → 50 bodů
- Price = VWAP + 1.5×ATR → 100 bodů
- EMA spread → extra bonus (až +30 bodů)

---

### 3️⃣ Likvidita + Volume (20% váha)

```typescript
volumeScore = (volume_24h_usd - 1M) / 49M * 100
```

**Interpretace:**
- Volume = 1M USD → 0 bodů (minimum)
- Volume = 25M USD → 50 bodů
- Volume = 50M USD → 100 bodů

---

### 4️⃣ Momentum Zpomalení (20% váha)

```typescript
if (ret_1h > 0) {
  momentumScore += 40  // Base for positive 1h
  
  if (ret_15m < ret_1h / 4) momentumScore += 30  // Slowing down
  if (ret_5m < ret_15m / 2) momentumScore += 30  // Slowing down more
}
```

**Interpretace:**
- ret_1h positive → 40 bodů (relief rally existuje)
- ret_15m < ret_1h/4 → +30 bodů (zpomaluje)
- ret_5m < ret_15m/2 → +30 bodů (zpomaluje dále)
- Ideál: 100 bodů (strong 1h rally, ale recent candles zpomalují)

---

### 5️⃣ Orderbook Absorpce (10% váha)

```typescript
ratio = askWall / (bidWall + askWall)
orderbookScore = ratio * 100
```

**Interpretace:**
- Vyšší ask wall % → více resistance → vyšší skóre
- 50/50 ratio → 50 bodů (neutral)
- 70% ask wall → 70 bodů (silná resistance)

---

## 🧮 Finální Skóre

```typescript
finalScore = (
  rsiScore * 0.25 +
  distanceScore * 0.25 +
  volumeScore * 0.20 +
  momentumScore * 0.20 +
  orderbookScore * 0.10
)

// Normalized to 0-1 for compatibility
normalizedScore = finalScore / 100
```

---

## 🎪 Basket Assignment

| Score Range | Basket | Význam |
|-------------|--------|--------|
| ≥ 0.62 | **Prime** | Nejvyšší kvalita, první volba |
| 0.52 - 0.61 | **Strong Watch** | Silný kandidát, watch closely |
| < 0.52 | **Speculative** | Spekulativní, vyšší riziko |

---

## 🔧 Konfigurace

V `config/candidates.json`:

```json
{
  "losers_overheat_relief": {
    "enabled": true,
    "target_candidates": {
      "min": 25,
      "max": 60,
      "ideal": 40
    },
    "must_have": {
      "ret_24h_pct_max": 0,
      "rsi_m15_min": 70,
      "rsi_h1_min": 60,
      "ema20_m15_above_ema50_pct_min": 0.5,
      "price_above_vwap_atr_min": 0.5,
      "volume_24h_usd_min": 1000000,
      "ret_1h_pct_min": 0,
      "ema20_h1_ema50_h1_diff_max_pct": 3.0
    },
    "guardrails": {
      "spread_bps_max": 400,
      "liquidity_usd_min": 50000,
      "price_must_be_above_ema20_m15": true,
      "ret_1h_must_be_positive": true
    },
    "scoring_weights": {
      "rsi_overheat": 0.25,
      "distance_vwap_ema": 0.25,
      "liquidity_volume": 0.20,
      "momentum_slowdown": 0.20,
      "orderbook_absorption": 0.10
    },
    "refresh_interval_minutes": 15
  }
}
```

**Zapnutí/vypnutí:**
- `"enabled": true` → archetype aktivní
- `"enabled": false` → archetype neaktivní

---

## 📍 Implementace

### Soubory

1. **`services/signals/candidate_selector.ts`**
   - Funkce: `scoreLosersOverheatRelief()` - scoring 0-100
   - Logika: filtering v `selectCandidates()` (řádek 340+)
   - Type: `archetype: 'losers_overheat_relief'`

2. **`config/candidates.json`**
   - Sekce: `losers_overheat_relief`
   - Konfigurace všech kritérií a vah

3. **`scripts/test_losers_overheat_relief.ts`**
   - Testovací skript s mock daty
   - Verifikace filtrovací logiky

---

## 🧪 Testování

```bash
# Spustit test s mock daty
npx tsx scripts/test_losers_overheat_relief.ts

# Sledovat real-time výběr v production
tail -f logs/short/signals.log | grep losers_overheat_relief
```

**Expected output:**
```
Branch counts: loser_cont=X, loser_fade=Y, overbought=Z, losers_overheat_relief=N
Archetype breakdown: losers_overheat_relief=N
```

---

## 📊 Příklad Perfektního Kandidáta

```typescript
{
  symbol: 'EXAMPLEUSDT',
  ret_24h_pct: -8.0,      // ✅ 24h loser
  ret_60m_pct: 3.5,       // ✅ Positive 1h relief
  ret_15m_pct: 1.2,       // ✅ Slowing down
  ret_5m_pct: 0.4,        // ✅ Slowing down more
  
  RSI_M15: 78,            // ✅ Overbought M15
  RSI_H1: 65,             // ✅ Overbought H1
  
  price: 100,
  vwap_m15: 96,           // ✅ Price > VWAP + 0.5×ATR (2.0×ATR)
  atr_m15: 2.0,
  
  ema20_M15: 99,          // ✅ EMA20 >> EMA50 (2.06% spread)
  ema50_M15: 97,
  
  ema20_H1: 98,           // ✅ EMA20 ≈ EMA50 (0.52% diff)
  ema50_H1: 97.5,
  
  volume24h_usd: 10M,     // ✅ High volume
  spread_bps: 50,         // ✅ Tight spread
  
  → Score: ~60-70 (Strong Watch / Prime basket)
}
```

---

## 🔄 Refresh & Monitoring

- **Refresh interval:** 15 minut (konfigovatelné)
- **Timeframes:** M15 + H1 pouze (M5 ignorovat - šum)
- **Max kandidáti:** 25-60 (ideál 40)
- **No predictions:** Pouze situational probability

---

## 🚨 Production Notes

1. **Nepoužívat fallbacks** - vždy jen přesná kritéria
2. **Monitoring:** Sledovat branch counts v logách
3. **Tuning:** Upravit váhy v configu podle performance
4. **Kombinace:** Archetype funguje vedle stávajících (loser_cont, loser_fade, overbought)

---

## 📚 Související

- **[PROJECT_OVERVIEW_SHORT.md](./PROJECT_OVERVIEW_SHORT.md)** - Overall system architecture
- **[PROMPTS_MAP.md](./PROMPTS_MAP.md)** - AI prompts pro trading decisions
- **[candidate_selector.ts](../services/signals/candidate_selector.ts)** - Implementace
- **[config/candidates.json](../config/candidates.json)** - Konfigurace

---

**Autor:** AI Agent + Petr Liesner  
**Datum:** 2025-10-20  
**Verze:** 1.0.0

