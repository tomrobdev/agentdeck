#!/bin/sh
# `pnpm dev`: start a dev daemon and the dashboard together, or just the
# dashboard when a daemon (usually the launchd service) already has the port.
set -eu
PORT="${AGENTDECK_PORT:-4317}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "agentdeck daemon already running on port $PORT; starting the app only (stop it with \`agentdeck uninstall\` to run a dev daemon)"
  exec pnpm dev:app
fi
exec pnpm run "/^dev:/"
