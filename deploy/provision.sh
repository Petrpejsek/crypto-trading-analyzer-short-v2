#!/usr/bin/env bash
set -euo pipefail

# Minimal provisioning script to deploy trader app on a fresh host
# - Installs Docker and Compose V2 if missing
# - Builds and starts the stack (backend, worker, Caddy)

if ! command -v docker >/dev/null 2>&1; then
  echo "[PROVISION] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[PROVISION] Docker Compose V2 missing. Ensure Docker version >= 20.10"
  exit 1
fi

echo "[PROVISION] Building and starting services..."
cd "$(dirname "$0")"/..
docker compose -f deploy/compose.yml up -d --build

echo "[PROVISION] Waiting for backend health..."
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:8789/api/trading/settings >/dev/null; then
    echo "[PROVISION] Backend is healthy."
    exit 0
  fi
  sleep 2
done

echo "[PROVISION] Backend did not become healthy in time." >&2
exit 1




