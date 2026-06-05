#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run check
rm -rf release
mkdir -p release/chatgpt-github-mcp-app
rsync -a \
  --exclude node_modules \
  --exclude dist \
  --exclude data \
  --exclude release \
  --exclude .env \
  ./ release/chatgpt-github-mcp-app/
(cd release && zip -qr chatgpt-github-mcp-app.zip chatgpt-github-mcp-app)
echo "release/chatgpt-github-mcp-app.zip"
