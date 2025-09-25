#!/usr/bin/env bash
set -euo pipefail

# Idempotent deploy script for trader app (backend + frontend build)
# Usage examples:
#   ./scripts/deploy.sh --dir /srv/trader --branch main
#   ./scripts/deploy.sh --dir /srv/trader --commit abcdef1
#   ./scripts/deploy.sh --dir /srv/trader --tag v1.2.3 --dry-run

APP_DIR=""
REF_TYPE="branch"  # branch|commit|tag
REF_VALUE="main"
PM2_NAME="trader-backend"
NODE_REQUIRED="18"
DRY_RUN=false

log() { echo "[DEPLOY] $*"; }
fail() { echo "[DEPLOY][ERROR] $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2;;
    --branch) REF_TYPE="branch"; REF_VALUE="$2"; shift 2;;
    --commit) REF_TYPE="commit"; REF_VALUE="$2"; shift 2;;
    --tag) REF_TYPE="tag"; REF_VALUE="$2"; shift 2;;
    --pm2-name) PM2_NAME="$2"; shift 2;;
    --dry-run) DRY_RUN=true; shift 1;;
    *) fail "Unknown arg: $1";;
  esac
done

[[ -z "$APP_DIR" ]] && fail "--dir is required (server checkout directory)"

# Preflight checks
need_cmd git
need_cmd node
need_cmd npm
need_cmd pm2

# Check Node version
NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
if [[ "$NODE_MAJOR" -lt "$NODE_REQUIRED" ]]; then
  fail "Node >=$NODE_REQUIRED required, found $(node -v)"
fi

# .env sanity
if [[ -f "$APP_DIR/.env" ]]; then
  log "Found .env"
else
  log "Warning: .env not found in $APP_DIR (will rely on environment variables)"
fi

run() {
  if $DRY_RUN; then
    echo "+ $*"
  else
    eval "$@"
  fi
}

# Fetch code
log "Updating repo at $APP_DIR"
run "cd '$APP_DIR'"
run "git fetch --all --tags"
case "$REF_TYPE" in
  branch)
    run "git checkout '$REF_VALUE'"
    run "git pull --ff-only"
    ;;
  commit)
    run "git fetch origin"
    run "git checkout '$REF_VALUE'"
    ;;
  tag)
    run "git checkout 'tags/$REF_VALUE'"
    ;;
esac

# Install deps and build
log "Installing dependencies"
run "npm ci"

log "Typecheck & build frontend"
run "npm run -s build"

# Restart backend via PM2
if $DRY_RUN; then
  log "DRY RUN: pm2 startOrReload ecosystem.config.js --only '$PM2_NAME'"
else
  if pm2 list | grep -q "$PM2_NAME"; then
    log "Reloading PM2 app: $PM2_NAME"
    pm2 reload "$PM2_NAME" || pm2 restart "$PM2_NAME"
  else
    log "Starting PM2 app: $PM2_NAME"
    pm2 start ecosystem.config.js --only "$PM2_NAME"
  fi
  pm2 save || true
fi

# Health-check
HC_URL="http://127.0.0.1:8789/api/trading/settings"
log "Health-check: $HC_URL"
if $DRY_RUN; then
  echo "+ curl -fsS $HC_URL | jq ."
else
  curl -fsS "$HC_URL" >/dev/null || fail "Health-check failed"
fi

log "Done"



