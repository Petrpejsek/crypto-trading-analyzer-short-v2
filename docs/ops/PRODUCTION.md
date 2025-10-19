## Production Operations – Trader

### Server
- Provider: DigitalOcean
- Droplet: 2 vCPU / 4 GB RAM / 35 GB SSD (s-2vcpu-4gb)
- Region: FRA1
- OS: Ubuntu 22.04 LTS

### Access
- SSH key (local): `~/.ssh/id_ed25519_trader_hetzner`
- Deploy user on server: `deploy` (passwordless sudo)
- Path: `/srv/trader`

### Domain / TLS
- Domain: `enermijo.cz`
- DNS:
  - A `@` → 164.90.163.107 (TTL 600s)
  - CNAME `www` → `enermijo.cz`
- TLS: Let’s Encrypt via certbot (auto-renew). Nginx configured with HTTPS and HTTP→HTTPS redirect.

### Reverse proxy (Nginx)
- Static UI: served from `/srv/trader/dist` (index.html, assets)
- API proxy:
  - `/api/` → `http://127.0.0.1:3081/api/`
  - `/__proxy/` → `http://127.0.0.1:3081/`
- Security:
  - Basic Auth enabled na statické části (UI). Uživatel `trader`, heslo uložené v `/etc/nginx/.htpasswd`.
  - Basic Auth je vypnuto pro `/api/` a `/__proxy/` (aby UI polling nespouštěl přihlašovací dialog).
  - Volitelně lze whitelisovat IP (viz níže).

### Dlouhá session (30 dní)
- Backend endpoint `GET /__auth` nastaví cookie `trader_auth=1` s `Max‑Age=2592000` (30 dní). Lze použít s Nginx `auth_request` (není nutné, aktuálně Basic Auth zůstává pouze pro UI).

### Process manager (PM2)

**SHORT instance (aktuální projekt):**
- Config: `ecosystem.short.config.cjs`
- Apps: `trader-short-backend` (port 3081), `trader-short-worker`
- Start: `pm2 start ecosystem.short.config.cjs`
- Persist: `pm2 save`
- Status/logs: `pm2 status`, `pm2 logs`

**Ruční start (legacy, nedoporučeno):**
- `pm2 start server/index.ts --interpreter /srv/trader/node_modules/.bin/tsx --name trader-backend --time`

**⚠️ DŮLEŽITÉ:**
- Vždy používej `ecosystem.short.config.cjs` pro konzistentní konfiguraci
- Backend + Worker se spouští jako samostatné PM2 aplikace
- Environment variables jsou definovány v ecosystem config
- Process Lock systém brání duplicitním instancím

### Deploy workflow

#### 1) První setup (na serveru)
```bash
# Základní nástroje
sudo apt-get update && sudo apt-get install -y git curl ufw nginx

# Node.js 20 (nodesource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 global
sudo npm i -g pm2

# Uživatel deploy
sudo adduser deploy
sudo usermod -aG sudo deploy
# Přidat SSH klíč do ~/.ssh/authorized_keys

# Clone repo
sudo mkdir -p /srv/trader
sudo chown deploy:deploy /srv/trader
cd /srv/trader
git clone <REPO_URL> .
```

#### 2) Temporal Cluster setup
```bash
# Start SHORT Temporal cluster
./temporal/start-short-cluster.sh

# Nebo Docker Compose
docker-compose -f deploy/compose.short-temporal.yml up -d

# Verify
temporal workflow list --namespace trader-short
```

#### 3) Environment konfigurace
```bash
# Vytvoř .env.local
cp env.SHORT.example .env.local
nano .env.local

# MUSÍ obsahovat:
# TEMPORAL_ADDRESS=127.0.0.1:7500
# TEMPORAL_NAMESPACE=trader-short
# TASK_QUEUE=entry-short
# TASK_QUEUE_OPENAI=openai-short
# TASK_QUEUE_BINANCE=binance-short
# + API klíče (Binance, OpenAI)
```

#### 4) Build a start
```bash
# Install dependencies
npm ci

# Build frontend (pokud potřeba)
npm run build

# Start PM2
pm2 start ecosystem.short.config.cjs
pm2 save

# Setup PM2 startup
pm2 startup systemd
# Spusť vygenerovaný příkaz

# Verify
pm2 status
npm run locks:check
```

#### 5) Nginx konfigurace
```bash
# Config soubor
sudo nano /etc/nginx/sites-available/trader

# Symlink
sudo ln -s /etc/nginx/sites-available/trader /etc/nginx/sites-enabled/

# Test
sudo nginx -t

# Reload
sudo systemctl reload nginx

# Certbot (TLS)
sudo certbot --nginx -d enermijo.cz -d www.enermijo.cz
```

### Běžné scénáře nasazení

#### Deploy posledního commitu (doporučeno)
```bash
ssh deploy@SERVER << 'EOF'
  cd /srv/trader
  
  # Backup
  git stash push -m "pre-deploy-backup-$(date +%Y%m%d-%H%M%S)"
  
  # Pull
  git fetch origin
  git checkout main
  git reset --hard origin/main
  
  # Install
  npm ci
  
  # Locks check
  npm run locks:check
  
  # Restart PM2
  pm2 restart ecosystem.short.config.cjs --update-env
  
  # Verify
  sleep 3
  pm2 status
  npm run locks:check
  curl -s http://localhost:3081/api/health
EOF
```

#### Deploy konkrétního commitu (testing)
```bash
ssh deploy@SERVER << 'EOF'
  cd /srv/trader
  
  # Backup
  git stash push -m "test-deploy-$(date +%Y%m%d-%H%M%S)"
  
  # Checkout commit
  git fetch origin
  git checkout <COMMIT_SHA>
  
  # Install & restart
  npm ci
  pm2 restart ecosystem.short.config.cjs --update-env
  
  # Verify
  sleep 3
  pm2 logs --lines 50
EOF

# Po ověření vrať zpět na main:
ssh deploy@SERVER 'cd /srv/trader && git checkout main && git reset --hard origin/main && npm ci && pm2 restart ecosystem.short.config.cjs'
```

#### Hard restart (při problémech)
```bash
ssh deploy@SERVER << 'EOF'
  cd /srv/trader
  
  # Stop vše
  pm2 stop all
  
  # Clear locks
  npm run locks:clear
  
  # Fresh start
  pm2 delete all
  pm2 start ecosystem.short.config.cjs
  pm2 save
  
  # Verify
  sleep 3
  pm2 status
  npm run locks:check
EOF
```

### Když `/srv/trader` existuje, ale chybí `scripts/deploy.sh`
- Je to v pořádku – skript není nutný pro runtime. Pro jednoduchost používej výše uvedené příkazy (git fetch/reset/build/reload).
- Pokud je v `/srv/trader` jiné repo nebo zastaralá kopie, použij „Čistý re‑clone“ (záloha + fresh clone).

### Deploy skript (lokálně na serveru)
- Skript: `scripts/deploy.sh`
- Využití: idempotentní update v `/srv/trader`, build, PM2 reload, health-check.
```bash
./scripts/deploy.sh --dir /srv/trader --branch main
# také podporuje: --commit <sha>  |  --tag <vX.Y.Z>  |  --pm2-name trader-backend  |  --dry-run
```

### Health‑check
- `GET http://127.0.0.1:3081/api/trading/settings` ⇒ `{ ok: true, pending_cancel_age_min: 0 }`
- Nginx proxy: `https://enermijo.cz/api/trading/settings`

### Firewall
- UFW: allow `OpenSSH`, `80`, `443`.
- Pokud chceš whitelist pro Basic Auth, do server blocku přidej např.:
```nginx
location / {
  allow <YOUR_IP>/32;
  deny all;
  # nebo nechat Basic Auth (výchozí) a pro sebe povolit IP:
  satisfy any;
  allow <YOUR_IP>/32;
  auth_basic "Restricted";
  auth_basic_user_file /etc/nginx/.htpasswd;
}
```

### Obnova/rollbacks
- PM2: `pm2 restart trader-backend`
- Git: `git -C /srv/trader fetch --all && git -C /srv/trader checkout <ref> && npm ci && npm run build && pm2 reload trader-backend`

### Process Lock System 🔒

**Automatická ochrana:**
- Backend a Worker vytváří lock files při startu (`runtime/locks/*.lock`)
- Brání duplicitnímu běhu instancí
- Automatický cleanup při graceful shutdown
- Stale lock detection a cleanup

**Utility příkazy:**
```bash
# Kontrola locks
npm run locks:check

# Očekávaný výstup v produkci:
[BACKEND] LOCKED
  PID:         12345
  Trade Side:  SHORT
  Status:      ✅ RUNNING

[WORKER] LOCKED
  PID:         12346
  Trade Side:  SHORT
  Status:      ✅ RUNNING

# Force clear locks (emergency)
npm run locks:clear

# Pak restart PM2
pm2 restart all
```

**Troubleshooting lock conflicts:**
```bash
# 1. Zjisti co běží
pm2 list
npm run locks:check

# 2. Stop všechno
pm2 stop all

# 3. Clear locks
npm run locks:clear

# 4. Start znovu
pm2 start ecosystem.short.config.cjs
```

📖 **Detailní dokumentace:** [docs/PROCESS_LOCK_SYSTEM.md](../PROCESS_LOCK_SYSTEM.md)

---

### Incident checklist
- `pm2 status` – ověř že backend i worker běží
- `pm2 logs trader-short-backend` – ověř chyby / port 3081
- `npm run locks:check` – ověř že locks jsou aktivní a zdravé
- `ss -ltnp | grep 80\|443\|3081` – ověř, že Nginx i Node poslouchají
- `curl http://localhost:3081/api/health` – health check backendu
- `temporal workflow list --namespace trader-short` – ověř Temporal cluster
- `nginx -t && systemctl reload nginx` – test a reload proxy
- Certbot log: `/var/log/letsencrypt/letsencrypt.log`


