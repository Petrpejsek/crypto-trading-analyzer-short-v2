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
- App name: `trader-backend`
- Start: `pm2 start server/index.ts --interpreter /srv/trader/node_modules/.bin/tsx --name trader-backend --time`
- Persist: `pm2 save`
- Status/logs: `pm2 status`, `pm2 logs trader-backend`

### Deploy workflow
1) První setup (na serveru):
   - `sudo apt-get update && sudo apt-get install -y git curl ufw nginx`
   - Node 18/20 (nodesource), `npm i -g pm2`
   - Vytvořit uživatele `deploy`, přidat ssh klíč
   - Klonovat repo do `/srv/trader` přes deploy key (read‑only)
2) Build a start:
   - `npm ci && npm run build`
   - `pm2 start ...` (viz výše)
3) Nginx conf: `/etc/nginx/sites-available/trader` (symlink do `sites-enabled`), certbot deploy

### Běžné scénáře nasazení
- Deploy posledního commitu na `main` (doporučeno):
```bash
ssh deploy@SERVER 'cd /srv/trader && git fetch origin && git checkout main && git reset --hard origin/main && npm ci && npm run -s build && pm2 reload trader-backend --update-env'
```
- Deploy konkrétního commitu (dočasně):
```bash
ssh deploy@SERVER 'cd /srv/trader && git fetch origin && git checkout <SHA> && npm ci && npm run -s build && pm2 restart trader-backend --update-env'
# Pozn.: po ověření vrať zpět na main:
ssh deploy@SERVER 'cd /srv/trader && git checkout main && git reset --hard origin/main && npm ci && npm run -s build && pm2 reload trader-backend'
```
- Čistý re‑clone (když repo nesedí / chybí skripty):
```bash
ssh deploy@SERVER 'sudo mv /srv/trader /srv/trader.bak-$(date +%Y%m%d%H%M%S) && sudo -u deploy git clone git@github.com:Petrpejsek/crypto-trading-analyzer.git /srv/trader && cd /srv/trader && npm ci && npm run -s build && pm2 start server/index.ts --interpreter /srv/trader/node_modules/.bin/tsx --name trader-backend --time'
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

### Incident checklist
- `pm2 logs trader-backend` – ověř chyby / port 3081
- `ss -ltnp | grep 80\|443\|3081` – ověř, že Nginx i Node poslouchají
- `nginx -t && systemctl reload nginx` – test a reload proxy
- Certbot log: `/var/log/letsencrypt/letsencrypt.log`


