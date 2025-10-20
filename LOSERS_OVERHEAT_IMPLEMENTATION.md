# ✅ Implementace: Losers Overheat Relief

## 🎯 Shrnutí

Implementován nový archetype **`losers_overheat_relief`** pro výběr alt universe kandidátů podle přesných kritérií pro fade přehřátých relief rally na 24h losers.

---

## 📦 Co bylo implementováno

### 1. **Nový Archetype v Candidate Selector**
   - Soubor: `services/signals/candidate_selector.ts`
   - Type: `archetype: 'losers_overheat_relief'`
   - Funkce: `scoreLosersOverheatRelief()` - scoring 0-100

### 2. **Filtrační Logika**
   
**MUST HAVE kritéria:**
- ✅ `ret_24h < 0` (24h loser)
- ✅ `RSI.m15 ≥ 70` (přehřátý M15)
- ✅ `RSI.h1 ≥ 60` (přehřátý H1)
- ✅ `EMA20.m15 - EMA50.m15 ≥ 0.5%` (přepálený impuls)
- ✅ `Price > VWAP + 0.5×ATR` (nad fair value)
- ✅ `volume_24h ≥ 1M USD` (vysoká likvidita)
- ✅ `ret_1h > 0` (positive relief rally)
- ✅ `|EMA20.h1 - EMA50.h1| ≤ 3%` (EMA convergence)

**GUARDRAILS (vyřazení):**
- ❌ `spread_bps > 400`
- ❌ `volume_24h < 50k USD`
- ❌ `price < ema20.m15`
- ❌ `ret_1h < 0`

### 3. **Scoring Systém (0-100)**

| Faktor | Váha | Popis |
|--------|------|-------|
| RSI Overheat | 25% | RSI M15/H1 přepálení |
| Distance VWAP/EMA | 25% | Vzdálenost od fair value |
| Liquidity + Volume | 20% | Objem a likvidita |
| Momentum Slowdown | 20% | Zpomalení růstu |
| Orderbook Absorption | 10% | Ask/bid wall ratio |

**Finální skóre:**
```typescript
finalScore = (
  rsiScore * 0.25 +
  distanceScore * 0.25 +
  volumeScore * 0.20 +
  momentumScore * 0.20 +
  orderbookScore * 0.10
)
```

### 4. **Konfigurace**
   - Soubor: `config/candidates.json`
   - Sekce: `losers_overheat_relief`
   - Zapnout/vypnout: `"enabled": true/false`

### 5. **Dokumentace**
   - `docs/LOSERS_OVERHEAT_RELIEF_ALGORITHM.md` - kompletní popis algoritmu
   - Detailní vysvětlení kritérií, scoring systému a příkladů

### 6. **Testovací Scripty**

**Test s mock daty:**
```bash
npx tsx scripts/test_losers_overheat_relief.ts
```

**Real-time kandidáti:**
```bash
npx tsx scripts/show_overheat_candidates.ts
```

---

## 🚀 Jak to použít

### 1. **Zapnutí archetype**

V `config/candidates.json`:
```json
{
  "losers_overheat_relief": {
    "enabled": true
  }
}
```

### 2. **Spuštění systému**

```bash
# Development mode
./dev.sh

# Production mode
npm run start
```

### 3. **Monitorování**

```bash
# Sledovat logy
tail -f logs/short/signals.log | grep losers_overheat_relief

# Zobrazit aktuální kandidáty
npx tsx scripts/show_overheat_candidates.ts
```

---

## 📊 Test Results

**Test proběhl úspěšně:**

```
✅ Perfect candidate (PERFECTUSDT):
   - ret_24h: -8.0%
   - RSI M15: 78, H1: 65
   - VWAP distance: 2.00×ATR
   - EMA20/EMA50 spread: 2.06%
   - Volume: $10M
   → Score: 0.5934 (Strong Watch)

❌ Failed candidates correctly filtered:
   - FAILRSIUSDT: RSI M15 < 70
   - FAILVWAPUSDT: Not above VWAP + 0.5×ATR
   - FAILLIQUSDT: Volume < 1M USD
   - FAILMOMOUSDT: ret_1h < 0
   - FAILSPREADUSDT: spread_bps > 400
```

**Branch counts:**
```
loser_cont=0, loser_fade=0, overbought=6, losers_overheat_relief=1
```

---

## 🔧 Tuning

Pokud chceš upravit kritéria nebo váhy, edituj `config/candidates.json`:

```json
{
  "losers_overheat_relief": {
    "must_have": {
      "rsi_m15_min": 70,  // ← Upravit zde
      "rsi_h1_min": 60,
      ...
    },
    "scoring_weights": {
      "rsi_overheat": 0.25,  // ← Upravit váhy zde
      "distance_vwap_ema": 0.25,
      ...
    }
  }
}
```

**Restart není potřeba** - config se načítá dynamicky.

---

## 📝 Změněné Soubory

1. ✅ `services/signals/candidate_selector.ts` - implementace logiky
2. ✅ `config/candidates.json` - konfigurace
3. ✅ `docs/LOSERS_OVERHEAT_RELIEF_ALGORITHM.md` - dokumentace
4. ✅ `scripts/test_losers_overheat_relief.ts` - test script
5. ✅ `scripts/show_overheat_candidates.ts` - helper script

---

## 🎓 Klíčové Pojmy

**Relief Rally:**
- Silný bounce nahoru po velkém poklesu
- Typicky short-lived exhaustion move
- Prime target pro fade do shortu

**Overheat:**
- RSI ≥ 70 na M15 (přehřátý sentiment)
- Price nad VWAP + 0.5×ATR (nad fair value)
- EMA spread vysoký (impuls vyčerpán)

**Exhaustion:**
- EMA20.H1 ≈ EMA50.H1 (convergence)
- Momentum zpomaluje (ret_15m < ret_1h/4)
- Orderbook resistance (vyšší ask wall)

---

## 🚨 Production Notes

1. **Kombinace s jinými archetypes:**
   - Archetype funguje paralelně s `loser_cont`, `loser_fade`, `overbought_blowoff`
   - Coiny můžou být vybrány do více archetypes (systém vybere nejvyšší skóre)

2. **Target counts:**
   - Cíl: 25-60 kandidátů (ideál 40)
   - Přísná kritéria → méně kandidátů v určitých market conditions

3. **Refresh interval:**
   - 15 minut (konfigurovatelné)
   - Timeframes: M15 + H1 pouze

4. **No fallbacks:**
   - Systém nikdy nepoužívá fallbacks
   - Pokud kritéria nesplněna → coin není vybrán

---

## 📞 Support

- **Dokumentace:** `docs/LOSERS_OVERHEAT_RELIEF_ALGORITHM.md`
- **Test script:** `scripts/test_losers_overheat_relief.ts`
- **Config:** `config/candidates.json`

---

**Status:** ✅ Hotovo a otestováno  
**Datum:** 2025-10-20  
**Autor:** AI Agent + Petr Liesner

