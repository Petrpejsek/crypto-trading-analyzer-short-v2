# Digital Ocean Production Setup Guide

Tento průvodce tě provede kompletním nastavením produkčního prostředí pro trader-short-v2 na Digital Ocean s doménou goozy.store.

## Přehled

**Server:** Digital Ocean Droplet  
**IP adresa:** `164.90.163.107`  
**Doména:** `goozy.store`  
**OS:** Ubuntu 22.04 LTS  
**Velikost:** 4GB RAM / 2 vCPUs / 35GB Disk

## 1. DNS Konfigurace

Před nasazením musíš nastavit DNS záznamy pro doménu `goozy.store`, aby směřovaly na tvůj droplet.

### Kroky:

1. **Přihlas se do správy domény** (Cloudflare, Namecheap, GoDaddy, atd.)

2. **Přidej A records:**

   | Type | Name | Value | TTL |
   |------|------|-------|-----|
   | A | @ | 164.90.163.107 | 300 (5 min) |
   | A | www | 164.90.163.107 | 300 (5 min) |

3. **Ověř DNS propagaci** (může trvat 5-60 minut):
   ```bash
   # Z lokálního počítače
   dig goozy.store +short
   dig www.goozy.store +short
   
   # Měly by vrátit: 164.90.163.107
   ```

> 💡 **Tip:** Můžeš použít [whatsmydns.net](https://www.whatsmydns.net/) pro kontrolu DNS propagace globálně.

## 2. Server Provisioning

### 2.1 SSH Připojení

```bash
# Z lokálního počítače
ssh root@164.90.163.107
```

> 🔐 Pokud jsi nastavil SSH key při vytváření dropletu, použije se automaticky.

### 2.2 Aktualizace systému

```bash
apt update && apt upgrade -y
```

### 2.3 Instalace Docker

```bash
# Instalace Docker
curl -fsSL https://get.docker.com | sh

# Ověř instalaci
docker --version
docker compose version
```

Měl bys vidět:
- `Docker version 24.x.x` nebo vyšší
- `Docker Compose version v2.x.x` nebo vyšší

### 2.4 Konfigurace Firewall (UFW)

```bash
# Povolit SSH, HTTP, HTTPS
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (pro Let's Encrypt)
ufw allow 443/tcp   # HTTPS
ufw allow 443/udp   # HTTP/3 (QUIC)

# Volitelně: Temporal Web UI (pouze pokud chceš vzdálený přístup)
# ufw allow 8501/tcp

# Aktivuj firewall
ufw --force enable

# Ověř status
ufw status
```

### 2.5 Vytvoření non-root uživatele (doporučeno)

```bash
# Vytvoř uživatele 'trader'
adduser trader

# Přidej do docker group
usermod -aG docker trader

# Přidej do sudo group
usermod -aG sudo trader

# Zkopíruj SSH authorized keys
rsync --archive --chown=trader:trader ~/.ssh /home/trader/

# Přepni se na nového uživatele
su - trader
```

> 💡 Od teď používej uživatele `trader` místo `root` pro větší bezpečnost.

## 3. Deployment Aplikace

### 3.1 Clone Repository

```bash
cd ~
git clone https://github.com/YOUR_USERNAME/trader-short-v2.git
cd trader-short-v2
```

> 🔑 Pokud je repo private, nastav SSH key nebo Personal Access Token.

### 3.2 Vytvoření Production Environment

```bash
# Zkopíruj template
cp env.production.template .env.production

# Edituj a vyplň credentials
nano .env.production
```

**Co vyplnit:**

1. **Binance API credentials:**
   - `BINANCE_API_KEY`: Tvůj Binance API klíč
   - `BINANCE_SECRET_KEY`: Tvůj Binance Secret klíč
   - Ujisti se že API key má oprávnění pro **Futures Trading**

2. **OpenAI credentials:**
   - `OPENAI_API_KEY`: sk-...
   - `OPENAI_ORG_ID`: org-...
   - `OPENAI_PROJECT`: proj-...

3. **PostgreSQL password:**
   - Vygeneruj silné heslo:
     ```bash
     openssl rand -base64 32
     ```
   - Nahraď `CHANGE_THIS_TO_STRONG_PASSWORD`

4. **Ostatní:** Ponech výchozí hodnoty pokud nevíš co děláš

**Uložení:**
- Ctrl+O, Enter (save)
- Ctrl+X (exit)

### 3.3 Spuštění Deployment Script

```bash
# Ujisti se že jsi v rootu projektu
cd ~/trader-short-v2

# Spusť deployment
./scripts/deploy.sh
```

Script automaticky:
1. ✅ Zkontroluje `.env.production`
2. ✅ Zbuilduje frontend
3. ✅ Vytvoří Docker image
4. ✅ Spustí všechny services (Temporal, PostgreSQL, Backend, Worker, Caddy)
5. ✅ Počká na health checks
6. ✅ Zobrazí status

**Očekávaný výstup:**
```
✅ Deployment complete!
```

### 3.4 Ověření Deployment

```bash
# Zkontroluj že všechny containery běží
docker compose -f deploy/compose.production.yml ps

# Měly by být všechny "Up (healthy)"
```

## 4. Ověření Funkčnosti

### 4.1 Test HTTPS

```bash
# Z lokálního počítače
curl -I https://goozy.store

# Mělo by vrátit: HTTP/2 200
```

### 4.2 Test Backend API

```bash
curl https://goozy.store/api/trading/settings

# Mělo by vrátit JSON s trading nastavením
```

### 4.3 Test Frontend

Otevři v prohlížeči: **https://goozy.store**

Měl bys vidět trading dashboard s aktuálními daty.

### 4.4 Temporal Web UI (volitelné)

Otevři v prohlížeči: **http://164.90.163.107:8501**

Měl bys vidět Temporal dashboard s workflows.

## 5. Monitoring

### 5.1 Sledování Logů

```bash
# Všechny logy
docker compose -f deploy/compose.production.yml logs -f

# Pouze backend
docker logs -f shortv2-backend-prod

# Pouze worker
docker logs -f shortv2-worker-prod

# Pouze Temporal
docker logs -f temporal-short-prod
```

### 5.2 Kontrola Stavu Services

```bash
docker compose -f deploy/compose.production.yml ps
```

### 5.3 Restart Services

```bash
# Restart backendu
docker compose -f deploy/compose.production.yml restart shortv2-backend

# Restart workera
docker compose -f deploy/compose.production.yml restart shortv2-worker

# Restart všeho
docker compose -f deploy/compose.production.yml restart
```

### 5.4 Stop Services

```bash
# Stop všech services (data zůstanou)
docker compose -f deploy/compose.production.yml down

# Stop a smazání volumes (⚠️ ZTRÁTA DAT!)
docker compose -f deploy/compose.production.yml down -v
```

## 6. Maintenance

### 6.1 Update Aplikace

```bash
cd ~/trader-short-v2

# Pull nejnovější změny
git pull origin main

# Rebuild a restart
./scripts/deploy.sh
```

### 6.2 Backup SQLite Database

```bash
# Vytvoř backup runtime databáze
docker cp shortv2-backend-prod:/app/runtime/temporal_short.db \
  ~/backups/temporal_short_$(date +%Y%m%d_%H%M%S).db

# Vytvoř backup adresář pokud neexistuje
mkdir -p ~/backups
```

### 6.3 Restore Database

```bash
# Stop backend
docker compose -f deploy/compose.production.yml stop shortv2-backend

# Restore backup
docker cp ~/backups/temporal_short_20251020_120000.db \
  shortv2-backend-prod:/app/runtime/temporal_short.db

# Start backend
docker compose -f deploy/compose.production.yml start shortv2-backend
```

### 6.4 Čištění Disk Space

```bash
# Odstranění starých images
docker image prune -a

# Odstranění nepoužívaných volumes
docker volume prune

# Kompletní cleanup (opatrně!)
docker system prune -a --volumes
```

## 7. Troubleshooting

### 7.1 Caddy nemůže získat SSL certifikát

**Příznaky:**
- HTTPS nefunguje
- HTTP vrací 502 Bad Gateway

**Řešení:**
1. Ověř že DNS záznamy jsou správně nastavené:
   ```bash
   dig goozy.store +short
   # Mělo by vrátit: 164.90.163.107
   ```

2. Ověř že porty 80 a 443 jsou otevřené:
   ```bash
   ufw status | grep -E "80|443"
   ```

3. Zkontroluj Caddy logy:
   ```bash
   docker logs caddy-shortv2-prod
   ```

4. Restart Caddy:
   ```bash
   docker compose -f deploy/compose.production.yml restart caddy
   ```

### 7.2 Backend není healthy

**Příznaky:**
- `docker compose ps` ukazuje backend jako "unhealthy"

**Řešení:**
1. Zkontroluj logy:
   ```bash
   docker logs shortv2-backend-prod
   ```

2. Ověř že `.env.production` obsahuje správné credentials

3. Zkontroluj že Temporal běží:
   ```bash
   docker logs temporal-short-prod
   ```

4. Restart backendu:
   ```bash
   docker compose -f deploy/compose.production.yml restart shortv2-backend
   ```

### 7.3 Worker nepracuje s workflows

**Příznaky:**
- Workflows se nezpracovávají
- Temporal Web UI ukazuje "No workers"

**Řešení:**
1. Zkontroluj worker logy:
   ```bash
   docker logs shortv2-worker-prod
   ```

2. Ověř že worker má správné TEMPORAL_ADDRESS:
   ```bash
   docker exec shortv2-worker-prod env | grep TEMPORAL
   # Mělo by být: TEMPORAL_ADDRESS=temporal-short:7233
   ```

3. Restart workera:
   ```bash
   docker compose -f deploy/compose.production.yml restart shortv2-worker
   ```

### 7.4 Out of disk space

**Řešení:**
```bash
# Zkontroluj využití disku
df -h

# Vyčisti Docker
docker system prune -a

# Vyčisti logy starší než 7 dní
find ~/trader-short-v2/logs -name "*.log" -mtime +7 -delete

# Případně upsize droplet na Digital Ocean dashboard
```

## 8. Security Best Practices

### 8.1 Pravidelné Updaty

```bash
# Každý týden
apt update && apt upgrade -y
```

### 8.2 Monitoring Přihlášení

```bash
# Zobraz poslední SSH přihlášení
last -a

# Zobraz failed login attempts
grep "Failed password" /var/log/auth.log
```

### 8.3 Automatické Backupy

Vytvoř cron job pro automatické backupy:

```bash
crontab -e

# Přidej řádek (backup každý den ve 2:00 AM):
0 2 * * * docker cp shortv2-backend-prod:/app/runtime/temporal_short.db ~/backups/temporal_short_$(date +\%Y\%m\%d).db
```

### 8.4 Rotace Binance API Keys

Každých 90 dní:
1. Vygeneruj nové API keys na Binance
2. Updatuj `.env.production`
3. Restart services: `./scripts/deploy.sh`

## 9. Kontakty a Support

- **GitHub Issues:** [github.com/YOUR_USERNAME/trader-short-v2/issues](https://github.com)
- **Digital Ocean Support:** [cloud.digitalocean.com/support](https://cloud.digitalocean.com/support)
- **Binance Support:** [binance.com/en/support](https://www.binance.com/en/support)

---

**Happy Trading! 🚀📈**

