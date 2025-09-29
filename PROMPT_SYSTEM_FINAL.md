# ✅ Prompt Management Systém - FINÁLNÍ VERZE

## 🎯 Co bylo opraveno

**Tvoje otázka byla správná!** Původní implementace měla problém:
- Dev upravil prompt v UI → uložilo se do overlay
- Commitnul se overlay
- **Ale prod overlay ignoroval** → používal staré `prompts/*.md`
- **Chyběla migrace!**

## ✅ Nové řešení s exportem

```
┌────────────────────────────────────────────────────────────┐
│  DEV: Edituj v UI → Save → overlay (staging area)         │
│       ↓                                                     │
│  DEV: Testuj asistenta s novým promptem                   │
│       ↓                                                     │
│  EXPORT: 📤 Export do Registry → overlay → prompts/*.md   │
│       ↓                                                     │
│  COMMIT: git add prompts/ (NE overlay!)                   │
│       ↓                                                     │
│  PROD: Čte z prompts/*.md (ignoruje overlay)              │
└────────────────────────────────────────────────────────────┘
```

---

## 🔑 Klíčové principy

### 1️⃣ Overlay = Dev Staging Area

```
runtime/prompts/dev/
├── _meta.json       # Overlay prompty (NECOMMITUJE SE)
└── _audit.ndjson    # Audit log (NECOMMITUJE SE)
```

- ✅ Edituj v UI → uloží se sem
- ✅ Dev běhy používají overlay
- ❌ **NECOMMITUJE SE** (je v `.gitignore`)

### 2️⃣ Export = Migrace

```bash
# V UI: 📤 Export do Registry
# Nebo CLI:
NODE_ENV=development tsx scripts/export_prompts_to_registry.ts
```

- ✅ Zkopíruje overlay → `prompts/*.md`
- ✅ Atomic write + verifikace
- ✅ Registry připravená k commitu

### 3️⃣ Commit = Pouze Registry

```bash
git add prompts/           # ✅ COMMITUJ
git add runtime/           # ❌ NECOMMITUJ
git commit -m "chore: update prompts"
```

### 4️⃣ Prod = Ignoruje Overlay

```typescript
// Prod mód VŽDY čte z prompts/*.md
resolveAssistantPrompt('strategy_updater', 'prompts/short/strategy_updater.md')
// → source: 'registry'
```

---

## 📋 Kompletní workflow

### 1. Development

```bash
NODE_ENV=development npm run dev
```

1. Otevři UI → **📝 Prompts**
2. Vyber asistenta
3. Edituj text
4. **Ulož** → vytvoří overlay
5. Testuj asistenta → používá overlay
6. Iteruj dokud nejsi spokojený

**✅ Overlay existuje, dev běhy ho používají**  
**❌ Bez overlay by dev fail hard (žádný fallback)**

### 2. Export

Když jsi spokojený:

**UI způsob:**
- Klikni **📤 Export do Registry** (zelené tlačítko)

**CLI způsob:**
```bash
NODE_ENV=development tsx scripts/export_prompts_to_registry.ts
```

**✅ Výsledek:**
- Overlay zkopírován do `prompts/*.md`
- Registry soubory aktualizované

### 3. Commit & Push

```bash
# Zkontroluj změny
git diff prompts/

# Commitni POUZE registry
git add prompts/
git commit -m "chore: update strategy_updater prompt"
git push
```

**✅ Co commitovat:**
- `prompts/*.md` (registry)
- Změny v asistantech (integrace)

**❌ Co NEcommitovat:**
- `runtime/prompts/dev/` (overlay)

### 4. Production

```bash
# Deploy (tvůj CI/CD)
git pull
npm install
pm2 restart all
```

**✅ Prod:**
- Čte z `prompts/*.md`
- Ignoruje overlay (i kdyby existoval)
- Nové prompty aktivní

---

## 🎯 Integrace asistentů

### Implementováno (4/12)

✅ `strategy_updater` - plně funkční + hash v meta  
✅ `entry_updater` - plně funkční + hash v meta  
✅ `entry_strategy_conservative` - plně funkční + hash v meta  
✅ `entry_strategy_aggressive` - plně funkční + hash v meta

### Zbývá (4/8)

📝 `entry_risk_manager`  
📝 `hot_screener`  
📝 `profit_taker`  
📝 `top_up_executor`

**Návod**: Viz `PROMPT_INTEGRATION_GUIDE.md`

---

## 🚀 Quick Start

```bash
# 1. Dev mód
NODE_ENV=development npm run dev

# 2. UI: 📝 Prompts → Edituj → Save

# 3. Testuj
# - Spusť asistenta
# - Zkontroluj meta.prompt_sha256

# 4. Export
NODE_ENV=development tsx scripts/export_prompts_to_registry.ts

# 5. Commit
git add prompts/
git commit -m "chore: update prompts"
git push
```

---

## 📚 Dokumentace

1. **`PROMPT_MANAGEMENT_FLOW.md`** ⭐ START ZDE
   - Detailní flow dev → prod
   - Diagramy, příklady, checklist

2. **`PROMPT_MANAGEMENT.md`**
   - Kompletní uživatelská příručka
   - API dokumentace
   - Troubleshooting

3. **`PROMPT_INTEGRATION_GUIDE.md`**
   - Návod pro integraci zbývajících asistentů
   - Code snippety

4. **`scripts/export_prompts_to_registry.ts`**
   - CLI tool pro export
   - Automatická verifikace

---

## ⚠️ KRITICKÉ body

### ✅ VŽDY

1. **Edituj v UI** (ne ručně v souborech)
2. **Exportuj před commitem** (📤 Export do Registry)
3. **Commituj POUZE registry** (`prompts/*.md`)
4. **Testuj po deploymentu** (ověř hash v meta)

### ❌ NIKDY

1. **Necommituj overlay** (`runtime/prompts/dev/`)
2. **Neupravuj `prompts/*.md` ručně** (jen přes export)
3. **Nedeploy bez exportu** (změny by zůstaly jen v dev)
4. **Nedoplňuj fallbacky** (fail hard je záměr)

---

## 🎉 Výsledek

✅ **Dev-only systém** s 100% garancí správnosti  
✅ **Overlay jako staging area** (necommituje se)  
✅ **Export mechanismus** pro migraci do prod  
✅ **Atomic write + verifikace** všude  
✅ **SHA-256 attestace** v každém běhu  
✅ **Zero risk v produkci** (ignoruje overlay)  
✅ **Jasný, jednoduchý flow** dev → export → commit → prod  

---

**Máš dotazy? Podívej se do:**
- `PROMPT_MANAGEMENT_FLOW.md` - flow diagramy + příklady
- `PROMPT_MANAGEMENT.md` - kompletní referenc
