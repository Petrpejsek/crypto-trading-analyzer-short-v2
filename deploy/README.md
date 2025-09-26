Deploy na enermijo.cz (Docker + Caddy)

Předpoklady na serveru
- Docker a Docker Compose V2
- Otevřené porty 80 a 443 (Caddy získá Let's Encrypt certifikát)
- SSH přístup a systémový uživatel (např. ubuntu)

Rychlé kroky
1) Zkopíruj repozitář na server (SSH)
2) Vytvoř .env soubor s produkčními hodnotami (viz .env.example v rootu)
3) Spusť build a stack:
   docker compose -f deploy/compose.yml up -d --build
4) Ověř zdraví backendu:
   curl -fsS http://127.0.0.1:8789/api/trading/settings
5) Ověř HTTPS na https://enermijo.cz

Poznámky
- Frontend statiku servíruje backend z /dist; Caddy pouze reverzně proxyuje doménu.
- Worker běží ve stejném image a spouští se přes pm2-runtime.
- PM2 uvnitř kontejneru loguje na stdout/stderr; logy zobrazíš: docker logs -f trader-backend




