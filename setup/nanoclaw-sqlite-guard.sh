#!/bin/sh
# nanoclaw-sqlite-guard.sh — ExecStartPre guard for NanoClaw systemd units.
#
# better-sqlite3 is a native addon compiled against a specific Node ABI
# (NODE_MODULE_VERSION). When Node is upgraded underneath an install, the
# stale binary fails to load and the host crash-loops silently at initDb().
# This guard test-loads the module under the *same* Node the service will run
# and rebuilds it only if the ABI no longer matches.
#
# NB: better-sqlite3 loads its native .node addon lazily inside the Database
# constructor (lib/database.js: `require('bindings')('better_sqlite3.node')`),
# NOT at require() time. A bare `require('better-sqlite3')` therefore passes
# even when the compiled binary is ABI-stale — which previously let the host
# crash-loop at initDb() while this guard reported "no rebuild needed". The
# probe below actually instantiates an in-memory DB to force the native load.
#
# Usage: nanoclaw-sqlite-guard.sh <repo-dir> <node-bin-dir>
#   <repo-dir>      absolute path to the nanoclaw checkout (WorkingDirectory)
#   <node-bin-dir>  dir containing the node/pnpm that ExecStart uses
set -eu

REPO="$1"
NODE_BIN_DIR="$2"
export PATH="$NODE_BIN_DIR:$PATH"
cd "$REPO"

if node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; then
  echo "[sqlite-guard] better-sqlite3 loads under $(node -v) — no rebuild needed"
  exit 0
fi

echo "[sqlite-guard] better-sqlite3 ABI mismatch under $(node -v) — rebuilding..."
pnpm rebuild better-sqlite3
echo "[sqlite-guard] rebuild complete"
