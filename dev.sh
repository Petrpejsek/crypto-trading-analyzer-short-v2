#!/usr/bin/env bash
set -euo pipefail

# Consistent, reliable dev orchestration for Trader SHORT V2
# - Strict ports (no fallbacks): frontend :4302, backend :8888 (BANNED: 4201/8789)
# - Health checks required; fail fast on errors
# - Cleans runtime logs/PIDs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FRONTEND_PORT="${FRONTEND_PORT:-4302}"
BACKEND_PORT="${BACKEND_PORT:-8888}"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
ENV_FILE="$SCRIPT_DIR/.env.local"
TEMPORAL_ADDRESS=""
TASK_QUEUE=""

info() { echo "[INFO] $*"; }
warn() { echo "[WARN] $*" >&2; }
err()  { echo "[ERROR] $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || err "Missing required command: $1"; }

# Hard guard: never use ports of the other project
guard_ports() {
  if [ "$FRONTEND_PORT" = "4201" ] || [ "$BACKEND_PORT" = "8789" ]; then
    err "BANNED_PORTS: 4201/8789 are reserved for another project. Use FRONTEND_PORT=4302 BACKEND_PORT=8888."
  fi
  if [ "$FRONTEND_PORT" = "$BACKEND_PORT" ]; then
    err "Invalid config: FRONTEND_PORT and BACKEND_PORT must differ."
  fi
}

stop_ports() {
  info "Stopping listeners on :$FRONTEND_PORT and :$BACKEND_PORT"
  for p in "$FRONTEND_PORT" "$BACKEND_PORT"; do
    pids=$(lsof -n -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "${pids:-}" ]; then
      info "Killing port $p PIDs: $pids"
      kill -9 $pids || true
    fi
  done
}

# Extra guard: also kill any rogue listeners on banned ports to avoid cross-project bleed
stop_banned_ports() {
  info "Stopping rogue listeners on banned ports :4201 and :8789 (if any)"
  for p in 4201 8789; do
    pids=$(lsof -n -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "${pids:-}" ]; then
      info "Killing banned port $p PIDs: $pids"
      kill -9 $pids || true
    fi
  done
}

stop_patterns() {
  info "Stopping dev processes by pattern (vite/tsx)"
  pkill -f "${SCRIPT_DIR}.*(vite|tsx|server/index.ts|npm run dev)" 2>/dev/null || true
}

stop_worker() {
  info "Stopping Temporal worker"
  if [ -f "$RUNTIME_DIR/worker.pid" ]; then
    pid=$(cat "$RUNTIME_DIR/worker.pid" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && ps -p "$pid" >/dev/null 2>&1; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.3
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$RUNTIME_DIR/worker.pid"
  fi
  pkill -f "$SCRIPT_DIR/temporal/worker.ts" 2>/dev/null || true
}

clean_runtime() {
  info "Cleaning runtime logs and PIDs"
  mkdir -p "$RUNTIME_DIR"
  rm -f "$RUNTIME_DIR"/*.pid "$RUNTIME_DIR"/*log "$RUNTIME_DIR"/*.out "$RUNTIME_DIR"/*.err 2>/dev/null || true
}

# Remove persisted state files that can be rehydrated and cause stale behavior
clean_runtime_state() {
  info "Cleaning runtime state JSON (waiting_tp/strategy_updater/entry_updater/top_up_watcher/cooldowns/background_trading)"
  rm -f \
    "$RUNTIME_DIR/waiting_tp.json" \
    "$RUNTIME_DIR/strategy_updater.json" \
    "$RUNTIME_DIR/entry_updater.json" \
    "$RUNTIME_DIR/top_up_watcher.json" \
    "$RUNTIME_DIR/cooldowns.json" \
    "$RUNTIME_DIR/background_trading.json" \
    2>/dev/null || true
}

preflight_env() {
  info "Reading env from $ENV_FILE"
  [ -f "$ENV_FILE" ] || err ".env.local missing. Create it with TEMPORAL_ADDRESS and TASK_QUEUE."
  TEMPORAL_ADDRESS=$(awk -F '=' '/^TEMPORAL_ADDRESS=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  TASK_QUEUE=$(awk -F '=' '/^TASK_QUEUE=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  TASK_QUEUE_OPENAI=$(awk -F '=' '/^TASK_QUEUE_OPENAI=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  TASK_QUEUE_BINANCE=$(awk -F '=' '/^TASK_QUEUE_BINANCE=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  OPENAI_API_KEY_VAL=$(awk -F '=' '/^OPENAI_API_KEY=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  OPENAI_ORG_ID_VAL=$(awk -F '=' '/^OPENAI_ORG_ID=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  OPENAI_PROJECT_VAL=$(awk -F '=' '/^OPENAI_PROJECT=/ {print $2}' "$ENV_FILE" | tail -n1 | tr -d '\r')
  [ -n "$TEMPORAL_ADDRESS" ] || err "TEMPORAL_ADDRESS missing in .env.local"
  [ -n "$TASK_QUEUE" ] || err "TASK_QUEUE missing in .env.local"
  [ -n "$TASK_QUEUE_OPENAI" ] || err "TASK_QUEUE_OPENAI missing in .env.local"
  [ -n "$TASK_QUEUE_BINANCE" ] || err "TASK_QUEUE_BINANCE missing in .env.local"
  export TEMPORAL_ADDRESS TASK_QUEUE
  export TASK_QUEUE_OPENAI TASK_QUEUE_BINANCE
  # Export OpenAI creds into environment for both backend and worker
  if [ -n "${OPENAI_API_KEY_VAL:-}" ]; then export OPENAI_API_KEY="$OPENAI_API_KEY_VAL"; fi
  if [ -n "${OPENAI_ORG_ID_VAL:-}" ]; then export OPENAI_ORG_ID="$OPENAI_ORG_ID_VAL"; fi
  if [ -n "${OPENAI_PROJECT_VAL:-}" ]; then export OPENAI_PROJECT="$OPENAI_PROJECT_VAL"; fi
}

preflight_temporal() {
  info "Checking Temporal at $TEMPORAL_ADDRESS"
  host="${TEMPORAL_ADDRESS%%:*}"
  port="${TEMPORAL_ADDRESS##*:}"
  [ -n "$host" ] && [ -n "$port" ] || err "Invalid TEMPORAL_ADDRESS format. Expected host:port"
  if ! nc -z -w 1 "$host" "$port" >/dev/null 2>&1; then
    err "Temporal server not reachable at $host:$port. Start it first (temporal server start-dev --headless --port $port)."
  fi
}

start_backend() {
  info "Starting backend on :$BACKEND_PORT"
  mkdir -p "$RUNTIME_DIR"
  # Enforce dev identity for this project: SHORT side and dev env (override any .env.local)
  NODE_ENV="development" \
  TRADE_SIDE="SHORT" \
  PORT="$BACKEND_PORT" \
  nohup npm run -s dev:server > "$RUNTIME_DIR/backend_dev.log" 2>&1 & echo $! > "$RUNTIME_DIR/backend.pid"
}

wait_backend() {
  info "Waiting for backend health"
  for i in {1..60}; do
    sleep 0.25
    if curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null; then
      info "Backend healthy"
      return 0
    fi
  done
  warn "Backend did not become healthy in time"
  tail -n 80 "$RUNTIME_DIR/backend_dev.log" || true
  err "Backend health check failed"
}

start_worker() {
  info "Starting Temporal worker (TASK_QUEUE=$TASK_QUEUE)"
  mkdir -p "$RUNTIME_DIR"
  NODE_ENV="development" \
  TRADE_SIDE="SHORT" \
  TEMPORAL_ADDRESS="$TEMPORAL_ADDRESS" \
  TASK_QUEUE="$TASK_QUEUE" \
  TASK_QUEUE_OPENAI="$TASK_QUEUE_OPENAI" \
  TASK_QUEUE_BINANCE="$TASK_QUEUE_BINANCE" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  OPENAI_ORG_ID="${OPENAI_ORG_ID:-}" \
  OPENAI_PROJECT="${OPENAI_PROJECT:-}" \
  nohup npm run -s dev:temporal:worker > "$RUNTIME_DIR/worker_dev.log" 2>&1 & echo $! > "$RUNTIME_DIR/worker.pid"
}

wait_worker() {
  info "Waiting for worker to be RUNNING"
  for i in {1..120}; do
    sleep 0.25
    if grep -q "Worker state changed" "$RUNTIME_DIR/worker_dev.log" 2>/dev/null && \
       grep -q "RUNNING" "$RUNTIME_DIR/worker_dev.log" 2>/dev/null; then
      info "Worker is RUNNING"
      return 0
    fi
  done
  warn "Worker did not become RUNNING in time"
  tail -n 120 "$RUNTIME_DIR/worker_dev.log" || true
  err "Worker startup failed"
}

start_frontend() {
  info "Starting frontend (Vite) on :$FRONTEND_PORT"
  mkdir -p "$RUNTIME_DIR"
  VITE_PROXY_TARGET="http://127.0.0.1:${BACKEND_PORT}" \
  nohup npm exec -s vite -- --port "$FRONTEND_PORT" > "$RUNTIME_DIR/frontend_dev.log" 2>&1 & echo $! > "$RUNTIME_DIR/frontend.pid"
}

wait_frontend() {
  info "Waiting for frontend root and proxy"
  for i in {1..80}; do
    sleep 0.25
    if curl -sf "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null; then
      break
    fi
  done
  curl -sf "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null || { tail -n 80 "$RUNTIME_DIR/frontend_dev.log" || true; err "Frontend root unreachable"; }
  # Proxy to backend health
  curl -sf "http://127.0.0.1:${FRONTEND_PORT}/api/health" >/dev/null || warn "Frontend proxy to /api/health failed (check backend)"
}

verify_singletons() {
  info "Verifying single listeners"
  local c1 c2
  c1=$(lsof -n -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -t | wc -l | tr -d ' ' || echo 0)
  c2=$(lsof -n -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -t | wc -l | tr -d ' ' || echo 0)
  if [ "$c1" != "1" ] || [ "$c2" != "1" ]; then
    warn "Listeners -> :$FRONTEND_PORT=$c1, :$BACKEND_PORT=$c2"
    lsof -n -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -P || true
    lsof -n -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -P || true
    err "Expected exactly one listener per port"
  fi
  info "Exactly one listener on each port"
}

status() {
  echo "--- STATUS ---"
  echo "PORT $FRONTEND_PORT"; lsof -n -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -P | cat
  echo "PORT $BACKEND_PORT"; lsof -n -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -P | cat
  echo "RUNTIME PIDs"; cat "$RUNTIME_DIR/frontend.pid" 2>/dev/null || true; cat "$RUNTIME_DIR/backend.pid" 2>/dev/null || true; cat "$RUNTIME_DIR/worker.pid" 2>/dev/null || true
}

logs() {
  echo "--- backend (tail) ---"; tail -n 120 "$RUNTIME_DIR/backend_dev.log" 2>/dev/null || true
  echo "--- frontend (tail) ---"; tail -n 120 "$RUNTIME_DIR/frontend_dev.log" 2>/dev/null || true
  echo "--- worker (tail) ---"; tail -n 120 "$RUNTIME_DIR/worker_dev.log" 2>/dev/null || true
}

usage() {
  cat <<EOF
Usage: ./dev.sh [start|stop|restart|restart:fresh|status|logs|clean:state]

Commands:
  start    Kill → clean → preflight → start backend+frontend+worker → verify
  stop     Stop listeners and dev processes including worker; clean runtime
  restart  stop then start (with preflight)
  restart:fresh  restart + purge runtime state JSON before start (no stale rehydrate)
  status   Show listeners and runtime PIDs
  logs     Tail recent logs for backend/frontend
  clean:state    Purge runtime state JSON only (safe to run while stopped)

Environment:
  FRONTEND_PORT (default $FRONTEND_PORT), BACKEND_PORT (default $BACKEND_PORT)
EOF
}

# Preflight
need_cmd lsof; need_cmd curl; need_cmd npm; need_cmd node; need_cmd nohup; need_cmd nc

cmd="${1:-}"
case "${cmd}" in
  start)
    guard_ports
    stop_ports; stop_banned_ports; stop_patterns; stop_worker; clean_runtime
    preflight_env; preflight_temporal
    start_backend; wait_backend
    start_frontend; wait_frontend
    start_worker; wait_worker
    verify_singletons
    status
    ;;
  stop)
    stop_ports; stop_banned_ports; stop_patterns; stop_worker; clean_runtime
    ;;
  restart|"")
    guard_ports
    stop_ports; stop_banned_ports; stop_patterns; stop_worker; clean_runtime
    preflight_env; preflight_temporal
    start_backend; wait_backend
    start_frontend; wait_frontend
    start_worker; wait_worker
    verify_singletons
    status
    ;;
  restart:fresh)
    guard_ports
    stop_ports; stop_banned_ports; stop_patterns; stop_worker; clean_runtime; clean_runtime_state
    preflight_env; preflight_temporal
    start_backend; wait_backend
    start_frontend; wait_frontend
    start_worker; wait_worker
    verify_singletons
    status
    ;;
  status)
    status
    ;;
  logs)
    logs
    ;;
  clean:state)
    clean_runtime_state
    ;;
  *)
    usage; exit 2
    ;;
esac

