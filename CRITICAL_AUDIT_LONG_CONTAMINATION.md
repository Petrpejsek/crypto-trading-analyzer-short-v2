# 🚨 KRITICKÝ AUDIT - LONG KONTAMINACE V SHORT PROJEKTU

**Datum:** 2025-09-30  
**Projekt:** trader-short-v2  
**Nalezeno:** 47+ výskytů LONG logiky v SHORT projektu

---

## ❌ KATEGORIE 1: DEFAULTS NA 'LONG' (KRITICKÉ!)

### Frontend UI Defaults:
```typescript
// src/ui/App.tsx:211
const [defaultSide, setDefaultSide] = useState<'LONG'|'SHORT'>(() => { ... })
// ❌ PROBLÉM: Default inicializace může být 'LONG'

// src/ui/App.tsx:1405
side: (c.side || 'LONG') as any,
// ❌ FALLBACK: Pokud side chybí, použije 'LONG'

// src/ui/App.tsx:1480
const sideLong = (o.side || 'LONG') === 'LONG'
// ❌ FALLBACK: Pokud side chybí, předpokládá 'LONG'

// src/ui/components/HeaderBar.tsx:39
defaultSide='LONG'
// ❌ PROP DEFAULT: Component default je 'LONG'

// src/ui/components/EntryControls.tsx:410
value={control.side || 'LONG'}
// ❌ FALLBACK: Pokud control.side chybí, použije 'LONG'

// src/ui/components/OrdersPanel.tsx:505,523
const s = String(side || 'LONG').toUpperCase()
String(p.positionSide||'LONG')
// ❌ FALLBACK: Pozice bez side předpokládá 'LONG'
```

### Backend Trading Defaults:
```typescript
// services/trading/binance_futures.ts (10+ výskytů!)
String(order.side || 'LONG').toUpperCase()  // řádky 1614, 1879, 1903, 1917, 1931, 1999, 2013, 2065, 2094, 2106
// ❌ FALLBACK: Pokud order nemá side, použije 'LONG'

// services/trading/watchdog.ts:80
await reduceOnlyMarket(w.symbol, w.side || 'LONG')
// ❌ FALLBACK: Watcher bez side předpokládá 'LONG'
```

**DOPAD:**  
Pokud kdekoli v kódu chybí `side` property, systém **automaticky použije LONG místo SHORT!**  
To znamená že SHORT projekt by mohl otevírat LONG pozice!

---

## ❌ KATEGORIE 2: OPAČNÁ DETEKCE SIDE Z POSITION AMOUNT

### Strategy Updater (KRITICKÉ!):
```typescript
// services/strategy-updater/trigger.ts:83
const side: 'LONG' | 'SHORT' = ps === 'LONG' ? 'LONG' : ps === 'SHORT' ? 'SHORT' : (amt > 0 ? 'LONG' : 'SHORT')

// services/strategy-updater/trigger.ts:113
const side: 'LONG' | 'SHORT' = ps === 'LONG' ? 'LONG' : ps === 'SHORT' ? 'SHORT' : (positionAmt > 0 ? 'LONG' : 'SHORT')
```

**PROBLÉM:**  
Binance Futures pro SHORT pozice používá **ZÁPORNÉ** positionAmt!  
- SHORT position = `positionAmt < 0`  
- LONG position = `positionAmt > 0`

**Současný kód:**
```
amt > 0 ? 'LONG' : 'SHORT'
```

Je **SPRÁVNĚ** pokud Binance vrací záporné amt pro SHORT!  
**ALE** pokud Strategy Updater dostane SHORT pozici která má `amt = -10`, pak:
- `amt > 0` = `false`
- Detekuje jako `'SHORT'` ✅ (SPRÁVNĚ!)

**OVĚŘENÍ NUTNÉ:** Potřebuji vidět reálné Binance API response!

---

## ❌ KATEGORIE 3: TEMPORAL WORKFLOWS (KRITICKÉ!)

### Trade Lifecycle:
```typescript
// temporal/workflows/trade_lifecycle.ts:36
const isLong = params.side === 'LONG'
const positionSide = isLong ? 'LONG' : 'SHORT'
```
**PROBLÉM:** Workflow očekává `params.side === 'LONG'` a řídí podle toho BUY/SELL  
V SHORT projektu by mělo být `params.side === 'SHORT'` vždy!

### Entry Assistant:
```typescript
// temporal/workflows/entry_assistant.ts:81
const sideBuy = input.side === 'LONG'
const positionSide = sideBuy ? 'LONG' : 'SHORT'
```
**PROBLÉM:** Workflow předpokládá `side === 'LONG'` = BUY order  
V SHORT projektu by mělo být `side === 'SHORT'` = SELL order vždy!

**DOPAD:**  
Pokud někdo zavolá Temporal workflow s `side: 'SHORT'`, workflow správně vytvoří SHORT pozici.  
ALE pokud někdo pošle `side: 'LONG'` (nebo není specifikováno), workflow vytvoří LONG pozici!

---

## ✅ KATEGORIE 4: LEGITIMNÍ POUŽITÍ (OK)

Tyto výskyty jsou **SPRÁVNÉ** - používají ternární operátory pro výpočty PnL/SL/TP:

```typescript
// Strategy updater calculations
const exitSide = entry.side === 'LONG' ? 'SELL' : 'BUY'  // ✅ OK
const pnl = (price - entry) * (side === 'LONG' ? 100 : -100)  // ✅ OK
currentSlLive = entry.side === 'LONG' ? Math.max(...candidates) : Math.min(...candidates)  // ✅ OK

// Server PnL calculations
unrealizedPnlPct: (entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * (side === 'LONG' ? 100 : -100) : 0)  // ✅ OK

// Validation checks
const okOrder = side === 'LONG'
  ? (p.sl < p.entry && p.entry < p.tp1 && p.tp1 <= p.tp2)  // ✅ OK
  : (p.tp1 <= p.tp2 && p.tp2 < p.entry && p.entry < p.sl)
```

---

## ⚠️ KATEGORIE 5: PODEZŘELÉ (VYŽADUJE KONTROLU)

### SetupsTable Filter:
```typescript
// src/ui/components/SetupsTable.tsx:135
if (settings.side_policy === 'long_only') return list.filter(s => s.side === 'LONG')
if (settings.side_policy === 'short_only') return list.filter(s => s.side === 'SHORT')
```
**OTÁZKA:** Proč SHORT projekt má `long_only` policy?  
**DOPORUČENÍ:** Odstranit `long_only` option kompletně!

---

## 🔥 PRIORITA OPRAV

### P0 - KRITICKÉ (OPRAVIT OKAMŽITĚ):
1. ✅ **HOTOVO** - `services/trading/binance_futures.ts:1100` - změněno na `!== 'SHORT'`
2. ✅ **HOTOVO** - `services/trading/binance_futures_batch.ts:335` - změněno na `!== 'SHORT'`
3. ✅ **HOTOVO** - `services/signals/candidate_selector.ts` - odstraněna LONG logika
4. ❌ **TODO** - Změnit VŠECHNY fallbacky `|| 'LONG'` → `|| 'SHORT'`:
   - `src/ui/App.tsx` (3 místa)
   - `src/ui/components/HeaderBar.tsx`
   - `src/ui/components/EntryControls.tsx`
   - `src/ui/components/OrdersPanel.tsx` (2 místa)
   - `services/trading/binance_futures.ts` (10+ míst!)
   - `services/trading/watchdog.ts`

### P1 - VYSOKÁ (OPRAVIT CO NEJDŘÍVE):
5. ❌ **TODO** - `temporal/workflows/trade_lifecycle.ts` - přidat guard aby nepřijal `side: 'LONG'`
6. ❌ **TODO** - `temporal/workflows/entry_assistant.ts` - přidat guard aby nepřijal `side: 'LONG'`
7. ❌ **TODO** - `src/ui/components/SetupsTable.tsx` - odstranit `long_only` policy

### P2 - STŘEDNÍ (NICE TO HAVE):
8. ❌ **TODO** - Přidat TypeScript strict typing: `side: 'SHORT'` (literal type, ne union)
9. ❌ **TODO** - Přidat runtime assertion v hlavních entry points: `assert(side === 'SHORT')`
10. ❌ **TODO** - Přidat unit testy které failnou pokud se objeví LONG

---

## 📊 SHRNUTÍ

- **Celkem analyzováno:** 113 TypeScript souborů
- **Nalezeno výskytů "LONG":** 47+
- **Kritických problémů:** 23 (defaults/fallbacks)
- **Opraveno:** 3/23 (13%)
- **Zbývá opravit:** 20 (87%)

---

## 🎯 ZÁVĚR

**SHORT projekt obsahuje MASIVNÍ kontaminaci LONG logikou!**

**Nejvážnější rizika:**
1. **Defaults na 'LONG'** - pokud chybí `side`, systém automaticky použije LONG
2. **Temporal workflows** - mohou být zavolány s `side: 'LONG'` a vytvoří LONG pozici
3. **Trading engine defaults** - 10+ míst kde se fallbackuje na 'LONG'

**Doporučení:**
- Opravit VŠECHNY fallbacky OKAMŽITĚ
- Přidat guarding na všech entry points
- Přidat runtime assertions
- Přidat unit testy

**Status:** ⚠️ SYSTÉM JE NEBEZPEČNÝ PRO PRODUKCI!
