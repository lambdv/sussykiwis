#!/bin/sh

# Start the Rust server and keep Nginx as PID 1.
# This keeps the container simple (single image) while still serving
# static files at `/` and proxying `/api/*` to the server.

set -eu

export PORT="${PORT:-3000}"

cleanup() {
  # Best-effort shutdown of background server.
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

/app/myserver &
SERVER_PID=$!

exec nginx -g 'daemon off;'
