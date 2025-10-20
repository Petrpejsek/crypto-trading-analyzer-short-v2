#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Production Deployment Script for trader-short-v2
# =============================================================================
# This script prepares and deploys the trading system to production
# 
# Prerequisites:
#   - .env.production file with all credentials
#   - Docker and Docker Compose V2 installed
#   - Domain DNS pointing to server IP
#   - Ports 80, 443 open on firewall
#
# Usage:
#   ./scripts/deploy.sh
# =============================================================================

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

COMPOSE_FILE="deploy/compose.production.yml"
ENV_FILE=".env.production"
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
IMAGE_TAG="trader-short-v2"

echo "=============================================="
echo "🚀 trader-short-v2 Production Deployment"
echo "=============================================="
echo "Git commit: $GIT_HASH"
echo "Project root: $PROJECT_ROOT"
echo ""

# =============================================================================
# Step 1: Pre-flight checks
# =============================================================================
echo "📋 Step 1/6: Pre-flight checks..."

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ ERROR: $ENV_FILE not found!"
  echo ""
  echo "Please create $ENV_FILE from env.production.template:"
  echo "  cp env.production.template .env.production"
  echo "  vim .env.production  # Fill in your credentials"
  exit 1
fi

# Check for required env vars
REQUIRED_VARS=(
  "BINANCE_API_KEY"
  "BINANCE_SECRET_KEY"
  "OPENAI_API_KEY"
  "POSTGRES_PASSWORD"
)

source "$ENV_FILE"

missing_vars=0
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ] || [[ "${!var:-}" == *"your_"* ]] || [[ "${!var:-}" == *"CHANGE_THIS"* ]]; then
    echo "❌ ERROR: $var is not set or contains placeholder value"
    missing_vars=1
  fi
done

if [ $missing_vars -eq 1 ]; then
  echo ""
  echo "Please update $ENV_FILE with real credentials"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ ERROR: Docker is not installed"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "❌ ERROR: Docker Compose V2 is not installed"
  exit 1
fi

echo "✅ Pre-flight checks passed"
echo ""

# =============================================================================
# Step 2: Build frontend
# =============================================================================
echo "📦 Step 2/6: Building frontend..."

if ! npm run build; then
  echo "❌ ERROR: Frontend build failed"
  exit 1
fi

echo "✅ Frontend built successfully"
echo ""

# =============================================================================
# Step 3: Build Docker image
# =============================================================================
echo "🐳 Step 3/6: Building Docker image..."

docker build -t "${IMAGE_TAG}:latest" -t "${IMAGE_TAG}:${GIT_HASH}" -f Dockerfile .

echo "✅ Docker image built: ${IMAGE_TAG}:latest, ${IMAGE_TAG}:${GIT_HASH}"
echo ""

# =============================================================================
# Step 4: Start services
# =============================================================================
echo "🚀 Step 4/6: Starting services..."

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

echo "✅ Services started"
echo ""

# =============================================================================
# Step 5: Wait for health checks
# =============================================================================
echo "🏥 Step 5/6: Waiting for health checks..."

max_wait=60
elapsed=0
health_ok=0

while [ $elapsed -lt $max_wait ]; do
  if docker compose -f "$COMPOSE_FILE" ps | grep -q "healthy"; then
    # Check specifically for backend health
    if docker inspect shortv2-backend-prod 2>/dev/null | grep -q '"Status": "healthy"'; then
      health_ok=1
      break
    fi
  fi
  
  echo -n "."
  sleep 2
  elapsed=$((elapsed + 2))
done

echo ""

if [ $health_ok -eq 0 ]; then
  echo "⚠️  WARNING: Services did not become healthy within ${max_wait}s"
  echo "Check logs with: docker compose -f $COMPOSE_FILE logs"
else
  echo "✅ Health checks passed"
fi

echo ""

# =============================================================================
# Step 6: Display status and next steps
# =============================================================================
echo "📊 Step 6/6: Deployment status"
echo ""

docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "=============================================="
echo "✅ Deployment complete!"
echo "=============================================="
echo ""
echo "🔍 Monitoring commands:"
echo "  - View all logs:        docker compose -f $COMPOSE_FILE logs -f"
echo "  - Backend logs:         docker logs -f shortv2-backend-prod"
echo "  - Worker logs:          docker logs -f shortv2-worker-prod"
echo "  - Temporal logs:        docker logs -f temporal-short-prod"
echo ""
echo "🌐 Access points:"
echo "  - Trading UI:           https://goozy.store"
echo "  - Backend API:          https://goozy.store/api/trading/settings"
echo "  - Temporal Web UI:      http://YOUR_SERVER_IP:8501"
echo ""
echo "🔧 Management commands:"
echo "  - Stop all:             docker compose -f $COMPOSE_FILE down"
echo "  - Restart backend:      docker compose -f $COMPOSE_FILE restart shortv2-backend"
echo "  - Restart worker:       docker compose -f $COMPOSE_FILE restart shortv2-worker"
echo "  - View service status:  docker compose -f $COMPOSE_FILE ps"
echo ""
echo "💾 Backup commands:"
echo "  - Backup runtime DB:    docker cp shortv2-backend-prod:/app/runtime/temporal_short.db ./backup_\$(date +%Y%m%d_%H%M%S).db"
echo ""
echo "📝 Next steps:"
echo "  1. Verify HTTPS works:  curl -I https://goozy.store"
echo "  2. Check backend API:   curl https://goozy.store/api/trading/settings"
echo "  3. Monitor logs for any errors"
echo "  4. Test a small trade to verify system functionality"
echo ""
