# Pre-Deployment Checklist

Tento checklist zajistí, že máš všechno připravené před nasazením do produkce.

## 📋 Před Deploym

### 1. Kódová Báze

- [ ] Všechny uncommitted změny jsou commitnuty
- [ ] Git repo je pushnutý na `origin/main`
- [ ] Lokální branch je synchronizovaný s remote
- [ ] Žádné WIP (work in progress) features v kódu

**Ověření:**
```bash
git status  # Mělo by být "nothing to commit, working tree clean"
git log origin/main..HEAD  # Mělo by být prázdné (žádné unpushed commits)
```

---

### 2. Testy a Kvalita

- [ ] Frontend se builduje bez chyb: `npm run build`
- [ ] TypeScript prochází: `npm run typecheck`
- [ ] Žádné kritické chyby v QA testech
- [ ] Health monitor funguje správně

**Ověření:**
```bash
npm run build       # Mělo by projít bez errorů
npm run typecheck   # Mělo by projít bez errorů
```

---

### 3. Konfigurace a Credentials

- [ ] `.env.production` je vytvořen z `env.production.template`
- [ ] Všechny API keys jsou vyplněny (ne placeholdery)
- [ ] Binance API key je **produkční** (ne testnet)
- [ ] Binance API key má správná oprávnění (Futures trading)
- [ ] OpenAI API key má dostatečný kredit ($20+ doporučeno)
- [ ] PostgreSQL heslo je silné (min. 32 znaků)

**Ověření:**
```bash
# Zkontroluj že .env.production neobsahuje placeholdery
grep -i "your_" .env.production  # Mělo by vrátit nic
grep -i "CHANGE_THIS" .env.production  # Mělo by vrátit nic
```

**Binance API oprávnění:**
- ✅ Enable Reading
- ✅ Enable Futures
- ❌ Enable Withdrawals (NIKDY!)
- ❌ Enable Internal Transfer (není potřeba)

---

### 4. Digital Ocean Server

- [ ] Droplet je vytvořen (Ubuntu 22.04 LTS)
- [ ] Minimálně 4GB RAM / 2 vCPUs
- [ ] SSH přístup funguje: `ssh root@164.90.163.107`
- [ ] Docker je nainstalovaný na serveru
- [ ] Docker Compose V2 je nainstalovaný na serveru
- [ ] Firewall má otevřené porty: 22 (SSH), 80 (HTTP), 443 (HTTPS)

**Ověření (na serveru):**
```bash
ssh root@164.90.163.107

# Zkontroluj Docker
docker --version           # Mělo by být 24.x.x+
docker compose version     # Mělo by být v2.x.x+

# Zkontroluj firewall
ufw status                 # Mělo ukázat 22, 80, 443 jako ALLOW
```

---

### 5. DNS Konfigurace

- [ ] Doména `goozy.store` je zaregistrovaná
- [ ] A record: `goozy.store` → `164.90.163.107`
- [ ] A record: `www.goozy.store` → `164.90.163.107`
- [ ] TTL nastaveno na 300s (5 min) pro rychlejší změny
- [ ] DNS propagace dokončena (ověřeno přes `dig`)

**Ověření (z lokálního počítače):**
```bash
dig goozy.store +short         # Mělo vrátit: 164.90.163.107
dig www.goozy.store +short     # Mělo vrátit: 164.90.163.107

# Alternativně
nslookup goozy.store
```

**Online nástroj:** [whatsmydns.net](https://www.whatsmydns.net/)

---

### 6. Binance Account

- [ ] Binance účet má dostatek USDT na margin ($100+ doporučeno)
- [ ] Futures account je aktivován
- [ ] Žádné existující SHORT pozice (konflikt)
- [ ] Trading hours jsou v povoleném rozmezí (ne víkend, ne US holiday)

**Ověření:**
- Přihlas se na [Binance Futures](https://www.binance.com/en/futures/BTC_USDT)
- Zkontroluj dostupný margin
- Zkontroluj že nemáš žádné otevřené SHORT pozice

---

### 7. OpenAI Account

- [ ] OpenAI API key je produkční (ne trial)
- [ ] Dostatek kreditu ($20+ doporučeno pro první měsíc)
- [ ] Žádné rate limity nebudou překročeny
- [ ] Organization a Project jsou správně nastaveny

**Ověření:**
- Přihlas se na [OpenAI Platform](https://platform.openai.com/)
- Zkontroluj Usage → Current usage
- Zkontroluj Billing → Payment methods

---

### 8. Deployment Files

- [ ] `deploy/compose.production.yml` existuje
- [ ] `deploy/Caddyfile` má správnou doménu (`goozy.store`)
- [ ] `scripts/deploy.sh` je executable (`chmod +x`)
- [ ] `Dockerfile` je aktuální
- [ ] `ecosystem.config.js` má správné PM2 nastavení

**Ověření:**
```bash
ls -la deploy/compose.production.yml
ls -la deploy/Caddyfile
ls -la scripts/deploy.sh
grep "goozy.store" deploy/Caddyfile  # Mělo vrátit něco
```

---

### 9. Monitoring Připravenost

- [ ] Temporal Web UI port (8501) je volitelně otevřen
- [ ] Máš ready SSH přístup pro debugging
- [ ] Máš ready způsob jak sledovat logy (`docker logs -f`)
- [ ] Máš backup plán (automatické backupy SQLite DB)

---

### 10. Risk Management

- [ ] Máš připravený "kill switch" (stop všech trades)
- [ ] Víš jak rychle zastavit systém (`docker compose down`)
- [ ] Máš testovací trade plán (začít s malým amount)
- [ ] Máš monitoring alerting nastavený (volitelné)

**Kill Switch:**
```bash
# SSH na server a zastavit vše
ssh root@164.90.163.107
cd ~/trader-short-v2
docker compose -f deploy/compose.production.yml down
```

---

## ✅ Final Check

Před spuštěním `./scripts/deploy.sh` zkontroluj že:

1. **Všechny checkboxy výše jsou zaškrtnuté** ☑️
2. **DNS propagace je dokončena** (minimálně 5 minut od změny)
3. **Máš připravený terminál pro monitoring** (`docker logs -f`)
4. **Je trading session otevřená** (ne víkend, ne US holiday)
5. **Máš čas sledovat první hodinu provozu** (důležité!)

---

## 🚀 Ready to Deploy?

Pokud jsou všechny checkboxy zaškrtnuté, jsi připravený nasadit:

```bash
# Na serveru
cd ~/trader-short-v2
./scripts/deploy.sh
```

---

## 🆘 Emergency Contacts

- **Digital Ocean Support:** https://cloud.digitalocean.com/support
- **Binance Support:** https://www.binance.com/en/support  
- **OpenAI Support:** https://help.openai.com/

---

**Good luck! 🍀 Trade safely! 📈**

