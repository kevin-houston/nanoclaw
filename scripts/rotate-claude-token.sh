#!/bin/bash
# rotate-claude-token.sh
#
# Reads claudeAiOauth.accessToken from ~/.claude/.credentials.json (the token
# refreshed by Claude Code CLI's /login flow, which has user:profile scope)
# and writes it into NanoClaw's .env as CLAUDE_CODE_OAUTH_TOKEN. Syncs
# data/env/env. If the token changed, kills any running agent containers so
# the next user message spawns a fresh container with the new token.
#
# Why: claude setup-token issues OAuth tokens without user:profile scope, and
# Claude Code CLI 2.x rejects them at startup with "Not logged in." Tokens
# from the /login flow have that scope but expire in ~7-8h. This script keeps
# .env in sync with the auto-refreshing credentials.json so the agent stays
# usable as long as Claude Code is logged in on this host.
#
# Run on a cron — every 5h is a safe cadence (token validity ~7-8h):
#   0 */5 * * * /home/kevin/nc/nc2/nanoclaw/scripts/rotate-claude-token.sh >> /home/kevin/nc/nc2/nanoclaw/logs/token-rotation.log 2>&1

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
ENV_MIRROR="$PROJECT_ROOT/data/env/env"
CREDS_FILE="$HOME/.claude/.credentials.json"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "[$(ts)] credentials.json not found at $CREDS_FILE — has /login been run?" >&2
  exit 1
fi

# Extract accessToken; bail if missing
NEW_TOKEN=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CREDS_FILE'))
    print(d['claudeAiOauth']['accessToken'])
except Exception as e:
    print('ERR:', e, file=sys.stderr)
    sys.exit(1)
" 2>&1)

if [[ -z "$NEW_TOKEN" || "$NEW_TOKEN" == ERR:* ]]; then
  echo "[$(ts)] failed to read accessToken: $NEW_TOKEN" >&2
  exit 1
fi

# Sanity-check shape — Claude OAuth tokens look like sk-ant-oat01-...
if [[ ! "$NEW_TOKEN" =~ ^sk-ant-oat[0-9]+- ]]; then
  echo "[$(ts)] accessToken doesn't look like an OAuth token (got prefix: ${NEW_TOKEN:0:15}...)" >&2
  exit 1
fi

CURRENT_TOKEN=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- || true)

if [[ "$NEW_TOKEN" == "$CURRENT_TOKEN" ]]; then
  echo "[$(ts)] token unchanged — no-op"
  exit 0
fi

# Update .env in place. Use awk for an atomic-ish in-place replacement.
TMP_ENV=$(mktemp)
trap 'rm -f "$TMP_ENV"' EXIT
awk -v new="CLAUDE_CODE_OAUTH_TOKEN=$NEW_TOKEN" '
  BEGIN { found = 0 }
  /^CLAUDE_CODE_OAUTH_TOKEN=/ { print new; found = 1; next }
  { print }
  END { if (!found) print new }
' "$ENV_FILE" > "$TMP_ENV"

# Preserve permissions
chmod --reference="$ENV_FILE" "$TMP_ENV" 2>/dev/null || chmod 600 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
trap - EXIT

# Mirror to data/env/env (read by the container)
mkdir -p "$(dirname "$ENV_MIRROR")"
cp "$ENV_FILE" "$ENV_MIRROR"

echo "[$(ts)] rotated CLAUDE_CODE_OAUTH_TOKEN (...${NEW_TOKEN: -8})"

# Kill running NanoClaw containers so the next message spawns fresh.
# Restrict to this install's slug to avoid touching peer installs.
KILLED=0
if command -v docker >/dev/null 2>&1; then
  # Compute install slug the same way as src/install-slug.ts: sha1(project-root)[:8].
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/setup/lib/install-slug.sh"
  SLUG=$(NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT" _nanoclaw_install_slug)
  for cid in $(docker ps --filter "label=nanoclaw-install=$SLUG" --format '{{.ID}}' 2>/dev/null); do
    docker kill "$cid" >/dev/null 2>&1 && KILLED=$((KILLED+1)) || true
  done
fi
if (( KILLED > 0 )); then
  echo "[$(ts)] killed $KILLED running container(s) (install=$SLUG); next message spawns fresh"
fi
