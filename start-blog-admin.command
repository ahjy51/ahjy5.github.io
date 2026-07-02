#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="${NODE_BIN:-}"
CODEX_NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [ -x "$CODEX_NODE" ]; then
    NODE_BIN="$CODEX_NODE"
  else
    echo "Node.js 22.12.0 or newer is required to start Blog Admin."
    echo "Install Node.js, or set NODE_BIN to a Node executable path."
    echo
    read -r -p "Press Enter to close this terminal..."
    exit 1
  fi
fi

PORT="${BLOG_ADMIN_PORT:-4322}"

echo "Starting Blog Admin..."
echo "Project: $(pwd)"
echo "URL: http://127.0.0.1:${PORT}/"
echo
echo "Keep this terminal open while editing."
echo "Close this terminal window or press Ctrl+C to stop the service."
echo

exec "$NODE_BIN" scripts/blog-admin.mjs
