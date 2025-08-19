#!/usr/bin/env bash
set -euo pipefail
read -rsp "Paste OpenAI API key (sk-… or sk-proj-…): " KEY; echo
# Accept both legacy sk- and project-scoped sk-proj- keys
case "$KEY" in sk-*|sk-proj-*) ;; *) echo "Invalid key format"; exit 1;; esac
umask 077
cat > .env.local <<EOT
OPENAI_API_KEY=$KEY
DECIDER_MODE=gpt
EOT
echo ".env.local written."
