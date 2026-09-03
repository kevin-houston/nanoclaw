#!/bin/bash
# rotate-claude-token-vault.sh
#
# Pushes claudeAiOauth.accessToken from ~/.claude/.credentials.json into the
# OneCLI vault secret that fronts api.anthropic.com.
#
# Why this exists: as of the "placeholder env for vault-backed third-party API
# keys" change, the container no longer receives CLAUDE_CODE_OAUTH_TOKEN in its
# environment — it gets ANTHROPIC_AUTH_TOKEN=placeholder and the OneCLI gateway
# swaps in the real Authorization header from the vault. So the old
# rotate-claude-token.sh (which writes .env) no longer keeps the agent alive;
# the vault copy is what matters. Claude /login access tokens expire in ~7-8h,
# so this must run on a cron or the agent starts returning "Invalid API key".
#
# No container restart is needed: the gateway looks up secrets per request.
#
# Cron — every 5h is a safe cadence:
#   0 */5 * * * /home/kevin/nc/nanoclaw-v2/scripts/rotate-claude-token-vault.sh >> /home/kevin/nc/nanoclaw-v2/logs/token-rotation-vault.log 2>&1

set -euo pipefail

# The generic secret with hostPattern api.anthropic.com, injected as
# `Authorization: Bearer {value}`. Override with SECRET_ID= if it is recreated.
SECRET_ID="${SECRET_ID:-87b072f3-37a2-4c0d-9681-1e473fde1c88}"
CREDS_FILE="$HOME/.claude/.credentials.json"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "[$(ts)] credentials.json not found at $CREDS_FILE — has /login been run?" >&2
  exit 1
fi

NEW_TOKEN=$(python3 -c "
import json, sys
try:
    print(json.load(open('$CREDS_FILE'))['claudeAiOauth']['accessToken'])
except Exception as e:
    print('ERR:', e, file=sys.stderr); sys.exit(1)
")

if [[ ! "$NEW_TOKEN" =~ ^sk-ant-oat[0-9]+- ]]; then
  echo "[$(ts)] accessToken doesn't look like an OAuth token (prefix: ${NEW_TOKEN:0:15}...)" >&2
  exit 1
fi

# Warn if the local token is itself expired — rotating a dead token fixes nothing.
python3 -c "
import json, time
d = json.load(open('$CREDS_FILE'))['claudeAiOauth']
exp = d.get('expiresAt')
if exp and int(exp) / 1000 < time.time():
    print('local access token is already expired; run /login')
" | while read -r line; do echo "[$(ts)] WARNING: $line" >&2; done

if onecli secrets update --id "$SECRET_ID" --value "$NEW_TOKEN" >/dev/null 2>&1; then
  echo "[$(ts)] pushed token to vault secret $SECRET_ID (...${NEW_TOKEN: -8})"
else
  echo "[$(ts)] onecli secrets update failed for $SECRET_ID" >&2
  exit 1
fi
