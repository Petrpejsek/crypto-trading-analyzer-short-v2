# 🚨 PORT 7800 STRICT BAN - DOKUMENTACE

## KRITICKÉ PRAVIDLO

**PORT 7800 JE PŘÍSNĚ ZAKÁZÁN PRO SHORT TRADING INSTANCI!**

- Port **7500** = SHORT trading (tento projekt)
- Port **7800** = LONG trading (jiná instance)
- Port **7234** = LONG trading (další instance)

## Implementované zábrany

### 1. `dev.sh` - Preflight kontrola
```bash
# Řádky 154-169
if echo "$TEMPORAL_ADDRESS" | grep -q ":7800"; then
  echo "🚨🚨🚨 FATAL ERROR 🚨🚨🚨"
  echo "❌ PORT 7800 IS STRICTLY FORBIDDEN!"
  exit 1
fi
```

**Efekt:** Pokud se pokusíš spustit `./dev.sh` s portem 7800 v `.env.local`, skript **OKAMŽITĚ HAVARUJE** s chybou.

### 2. `temporal/worker.ts` - Worker startup kontrola
```typescript
// Řádky 23-38
if (env.temporalAddress.includes(':7800')) {
  console.error('🚨🚨🚨 FATAL ERROR 🚨🚨🚨')
  console.error('❌ PORT 7800 IS STRICTLY FORBIDDEN!')
  process.exit(1)
}
```

**Efekt:** Pokud Worker detekuje port 7800, **OKAMŽITĚ SE UKONČÍ** s fatal error.

### 3. `server/index.ts` - Backend startup kontrola
```typescript
// Řádky 50-67
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || ''
if (TEMPORAL_ADDRESS.includes(':7800')) {
  console.error('🚨🚨🚨 FATAL ERROR 🚨🚨🚨')
  console.error('❌ PORT 7800 IS STRICTLY FORBIDDEN!')
  process.exit(1)
}
```

**Efekt:** Pokud Backend detekuje port 7800, **OKAMŽITĚ SE UKONČÍ** s fatal error.

## Jak to funguje

1. **Kontrola při startu `dev.sh`:**
   - Načte se `.env.local`
   - Zkontroluje se `TEMPORAL_ADDRESS`
   - Pokud obsahuje `:7800` → FATAL ERROR

2. **Kontrola při startu Worker:**
   - Worker načte env
   - Zkontroluje `temporalAddress`
   - Pokud obsahuje `:7800` → process.exit(1)

3. **Kontrola při startu Backend:**
   - Backend načte env
   - Zkontroluje `TEMPORAL_ADDRESS`
   - Pokud obsahuje `:7800` → process.exit(1)

## Správná konfigurace

### `.env.local` MUSÍ obsahovat:
```bash
TEMPORAL_ADDRESS=127.0.0.1:7500
TEMPORAL_NAMESPACE=trader-short
TASK_QUEUE=entry-short
TASK_QUEUE_OPENAI=openai-short
TASK_QUEUE_BINANCE=binance-short
TRADE_SIDE=SHORT
```

### ❌ NIKDY:
```bash
TEMPORAL_ADDRESS=127.0.0.1:7800  # ← FORBIDDEN!
```

## Test zákazu

Pro otestování že zákaz funguje:

```bash
# 1. Dočasně změň .env.local na port 7800
sed -i.bak 's/:7500/:7800/' .env.local

# 2. Zkus spustit dev.sh
./dev.sh restart
# Očekávaný výsledek: FATAL ERROR s chybovou hláškou

# 3. Vrať zpět správný port
mv .env.local.bak .env.local
```

## Důvod

Tento projekt je **VÝHRADNĚ pro SHORT trading**. Port 7800 je používán jinou instancí pro LONG trading. Připojení na špatný port by způsobilo:

- ❌ Cross-contamination dat mezi SHORT/LONG instancemi
- ❌ Nesprávné obchody (SHORT strategie na LONG datech)
- ❌ Temporal workflow kolize
- ❌ Databázové konflikty

## Historie

- **2025-10-19**: Implementován strict ban na port 7800 ve všech 3 kritických bodech
- Důvod: Prevence cross-contamination mezi SHORT a LONG trading instancemi

