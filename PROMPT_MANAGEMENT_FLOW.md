# Prompt Management Flow (DEV → PROD)

## 🎯 Správný flow od začátku do konce

### 1️⃣ Development (úpravy promptů)

```bash
# Dev mód
NODE_ENV=development npm run dev
```

**V UI:**
1. Klikni na **📝 Prompts**
2. Vyber asistenta
3. Edituj prompt
4. **Ulož** → vytvoří/updatne overlay v `runtime/prompts/dev/_meta.json`
5. Testuj asistenta s novým promptem
6. Opakuj dokud nejsi spokojený

**Co se děje:**
- ✅ Prompt se uloží do overlay (`runtime/prompts/dev/_meta.json`)
- ✅ Dev běhy používají overlay (fail hard pokud chybí)
- ✅ SHA-256 attestace v každém běhu
- ❌ `prompts/*.md` se NEZMĚNÍ

---

### 2️⃣ Export do Registry (migrace změn)

Když jsi spokojený s prompty v dev:

**Varianta A: Přes UI**
1. V Prompt Management modalu klikni na **📤 Export do Registry**
2. Potvrd export
3. Overlay se zkopírují do `prompts/*.md`

**Varianta B: Přes CLI**
```bash
NODE_ENV=development tsx scripts/export_prompts_to_registry.ts
```

**Co se děje:**
- ✅ Overlay texty se zkopírují do `prompts/*.md`
- ✅ Atomic write + read-after-write verifikace
- ✅ Registry soubory jsou připravené k commitu
- ⚠️ Overlay v `runtime/` zůstává (můžeš ho smazat nebo nechat)

---

### 3️⃣ Commit & Push

```bash
# Zkontroluj změny
git diff prompts/

# Commitni POUZE prompts/*.md
git add prompts/
git commit -m "chore: update prompts - [stručný popis změn]"

# Push
git push
```

**Co COMMITOVAT:**
- ✅ `prompts/*.md` (registry soubory)
- ✅ Změny v asistantech (integrace `resolveAssistantPrompt`)
- ❌ `runtime/prompts/dev/_meta.json` (overlay - NECOMMITUJ)
- ❌ `runtime/prompts/dev/_audit.ndjson` (audit log - NECOMMITUJ)

**Poznámka**: `runtime/` je v `.gitignore`, takže overlay se automaticky ignoruje

---

### 4️⃣ Production

```bash
# Prod deploy
# (podle tvého CI/CD procesu)
```

**Co se děje:**
- ✅ Prod čte **POUZE** z `prompts/*.md` (registry)
- ❌ Overlay se ignoruje (i kdyby existoval)
- ✅ Nové prompty jsou aktivní

---

## 📊 Diagram flow

```
┌─────────────────────────────────────────────────────────────────┐
│                          DEVELOPMENT                            │
└─────────────────────────────────────────────────────────────────┘

UI Edit → Save
    ↓
runtime/prompts/dev/_meta.json (overlay)
    ↓
Dev běhy používají overlay
    ↓
Testování + iterace
    ↓
Spokojený? → Export

┌─────────────────────────────────────────────────────────────────┐
│                            EXPORT                                │
└─────────────────────────────────────────────────────────────────┘

📤 Export do Registry
    ↓
Overlay → prompts/*.md
    ↓
Atomic write + verifikace
    ↓
prompts/*.md připravené k commitu

┌─────────────────────────────────────────────────────────────────┐
│                         COMMIT & DEPLOY                          │
└─────────────────────────────────────────────────────────────────┘

git add prompts/
git commit
git push
    ↓
CI/CD Deploy
    ↓
Prod používá prompts/*.md
```

---

## ⚠️ KRITICKÉ body

### Dev mód

✅ **Overlay je POVINNÝ** po prvním save
- První save vytvoří overlay
- Další běhy asistenta failnou pokud overlay chybí
- Žádné fallbacky!

❌ **Overlay se NECOMMITUJE**
- Je to jen dev staging area
- `runtime/` je v `.gitignore`

### Prod mód

✅ **Čte POUZE z registry**
- Vždy `prompts/*.md`
- Overlay se ignoruje (i kdyby existoval)

✅ **Zero overhead**
- Žádná dependency na `runtime/`
- Čistý, jednoduchý kód

### Migrace změn

✅ **Export je POVINNÝ**
- Bez exportu změny zůstanou jen v dev
- Export = migrace overlay → registry

✅ **Commituj POUZE registry**
- `prompts/*.md` → commituj
- `runtime/prompts/dev/` → ignoruj

---

## 🔥 Rychlý checklist

**Před commitem:**
```bash
# ✅ Exportoval jsem overlay → registry?
NODE_ENV=development tsx scripts/export_prompts_to_registry.ts

# ✅ Zkontroloval jsem změny?
git diff prompts/

# ✅ Commituju POUZE prompts/*.md?
git add prompts/
# NE: git add runtime/

# ✅ Napsal jsem smysluplný commit message?
git commit -m "chore: update strategy_updater prompt - fix SL logic"
```

**Po deployu:**
```bash
# ✅ Ověř, že prod používá nové prompty
# - Spusť asistenta
# - Zkontroluj meta.prompt_sha256
# - Porovnej s hashem v registry
```

---

## 💡 Tipy

### Rychlá verifikace

```bash
# Spočítej hash promptu v registry
sha256sum prompts/short/strategy_updater.md

# Porovnej s hashem z běhu asistenta
# (meta.prompt_sha256)
```

### Cleanup overlay po exportu

```bash
# Pokud chceš smazat overlay (volitelné)
rm runtime/prompts/dev/_meta.json
rm runtime/prompts/dev/_audit.ndjson
```

### Rollback změn

```bash
# Pokud jsi exportoval špatnou verzi
git restore prompts/short/strategy_updater.md

# A zkus to znovu
```

---

**Shrnutí:**
1. **Dev**: Edituj v UI → uloží se do overlay
2. **Export**: Overlay → `prompts/*.md`
3. **Commit**: Commituj `prompts/*.md`
4. **Prod**: Používá `prompts/*.md`

✅ Jasný, jednoduchý, bezpečný flow!
