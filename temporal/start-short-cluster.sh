#!/bin/bash
# Start dedicated Temporal cluster for SHORT trading instance
# Port 7500 - NEVER use 7233/7234 to avoid contamination with LONG instance

set -e

echo "🚀 Starting SHORT Temporal Cluster..."
echo "   Port: 7500"
echo "   Namespace: trader-short"
echo "   Database: ./runtime/temporal_short.db"
echo ""
echo "⚠️  NEVER use port 7234 - that's reserved for LONG instance!"
echo ""

# Create runtime directory if it doesn't exist
mkdir -p ./runtime

# Start Temporal server in dev mode with SHORT-specific configuration
temporal server start-dev \
  --headless \
  --port 7500 \
  --db-filename ./runtime/temporal_short.db \
  --namespace trader-short

