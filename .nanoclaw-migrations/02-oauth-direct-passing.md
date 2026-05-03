# 02 — OAuth direct passing (replace credential proxy server)

> **v2 final (applied 2026-05-02):** Three things together are required for OAuth to work in v2 — a single one is necessary but not sufficient. The original v1 procedure (gutting native-credential-proxy) is preserved at the bottom for historical reference; the v2-final pattern that actually works is documented here.
>
> ### v2-final pattern
>
> 1. **Code change in `src/container-runner.ts`** — inject `CLAUDE_CODE_OAUTH_TOKEN` after `onecli.applyContainerConfig`, so Docker's last-wins env semantics override OneCLI's `ANTHROPIC_API_KEY=placeholder`. Commit `fe18ce9`.
>
>    ```typescript
>    // After onecli.applyContainerConfig(...) in buildContainerArgs:
>    const { CLAUDE_CODE_OAUTH_TOKEN } = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
>    if (CLAUDE_CODE_OAUTH_TOKEN) {
>      args.push('-e', 'ANTHROPIC_API_KEY=');
>      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}`);
>    }
>    ```
>
> 2. **Per-agent OneCLI vault must NOT auto-inject `x-api-key`.** With `secretMode: all`, OneCLI's gateway adds an `x-api-key` header to every `api.anthropic.com` request from the agent's vault entry — Anthropic prefers `x-api-key` over `Authorization: Bearer`, so the OAuth token gets ignored. Switch the agent to `selective` (no secrets) so the proxy passes the Bearer token through cleanly:
>
>    ```bash
>    # one-time per agent
>    onecli agents set-secret-mode --id <agent-id> --mode selective
>    # If you later want to inject vault secrets for non-Anthropic services,
>    # use `onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>`
>    # but make sure the Anthropic API secret is NOT in that list.
>    ```
>
> 3. **Token rotation.** `CLAUDE_CODE_OAUTH_TOKEN` must be a `/login`-issued OAuth access token — those have `user:profile` scope, which Claude Code CLI's startup validation requires. Tokens from `claude setup-token` lack that scope and fail with "Not logged in." `/login`-issued accessTokens expire in ~7-8h, but Claude Code refreshes `~/.claude/.credentials.json` automatically while logged in. Use the cron-driven rotation script:
>
>    ```
>    scripts/rotate-claude-token.sh
>    ```
>
>    Cron entry:
>    ```
>    0 */5 * * * /home/kevin/nc/nc2/nanoclaw/scripts/rotate-claude-token.sh >> /home/kevin/nc/nc2/nanoclaw/logs/token-rotation.log 2>&1
>    ```
>
>    The script reads `claudeAiOauth.accessToken` from `~/.claude/.credentials.json`, writes it to `.env` + `data/env/env`, and kills the install's running container (filtered by `nanoclaw-install=<slug>` label) so the next message spawns fresh.
>
> ### Failure modes if any single piece is missing
>
> - **Code change missing:** OneCLI's `ANTHROPIC_API_KEY=placeholder` wins. Vault `x-api-key` injection still happens. If vault has a valid API key → works on API key auth (no OAuth needed). If vault has no key or stale key → "Invalid API key."
> - **Vault still on `mode: all`:** OAuth Bearer auth and vault `x-api-key` injection collide. Result: "Not logged in" or "Invalid API key" depending on the vault key validity.
> - **Token from `claude setup-token`:** Inference works (`/v1/messages` accepts the token), but Claude Code CLI's startup profile lookup at `/api/oauth/profile` fails with `permission_error: OAuth token does not meet scope requirement any_of(user:profile, user:office)`. Result: "Not logged in." Only `/login` browser-flow tokens have `user:profile`.
> - **Stale `continuation:claude` in `session_state`:** When you change auth config, existing Claude Code sessions cached on disk inside the container's `~/.claude/projects/<group>/<session-id>.jsonl` may carry stale state. After any auth-config change, clear the row: `sqlite3 data/v2-sessions/<agent-group>/sess-<sess>/outbound.db "DELETE FROM session_state WHERE key='continuation:claude';"` and kill the running container — next message starts fresh.
>
> ### Trade-off
>
> This pattern requires the operator to stay logged in via Claude Code CLI on this host. If `claude` isn't run for an extended period, `~/.claude/.credentials.json` won't refresh and the rotation script will copy an expired token. To recover, run `claude` interactively once (any command will trigger a refresh, e.g. `claude --print "ping"`).

---

## Original v1 procedure (kept for historical reference)


**Apply when:** Skill `upstream/skill/native-credential-proxy` has been merged AND the cross-skill dedup in `01-skill-interactions.md` is done.

**Why:** The native-credential-proxy skill stands up an HTTP server that intercepts `https://api.anthropic.com` and rewrites credentials. With long-lived OAuth tokens (`CLAUDE_CODE_OAUTH_TOKEN`) that lack the `org:create_api_key` scope, the proxy's token-exchange flow fails and the SDK reports "Not logged in." The user replaced the proxy with direct credential injection: containers receive `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) as real environment variables, and the Claude Code SDK handles auth natively.

**Files affected:**
- `src/credential-proxy.ts`
- `src/container-runner.ts`
- `src/index.ts`

---

## How to apply

### 1. Gut `src/credential-proxy.ts`

Replace the entire file with the lean version below. The skill's `startCredentialProxy()` function and HTTP server implementation are deleted; only `detectAuthMode()` and a new `getAuthSecret()` survive.

```typescript
import { readEnvFile } from './env.js';

export type AuthMode = 'api-key' | 'oauth';

/**
 * Detect which Anthropic auth mode the host is configured for, based on .env.
 * Returns 'api-key' if ANTHROPIC_API_KEY is set, otherwise 'oauth'.
 */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Read the active Anthropic auth secret from .env for direct injection
 * into containers. Falls back to 'placeholder' to keep the SDK from
 * crashing on missing credentials (the SDK will report a clear auth error).
 */
export function getAuthSecret(): string {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return (
    secrets.ANTHROPIC_API_KEY ||
    secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN ||
    'placeholder'
  );
}
```

Make sure these are deleted from the file:

- `startCredentialProxy(...)` function and everything inside it
- `ProxyConfig` interface
- All imports of `createServer`, `httpsRequest`, `httpRequest`, `RequestOptions`, `Server`, `logger`

### 2. Update `src/container-runner.ts`

Two changes here.

**a) Imports** — add `getAuthSecret` and remove proxy-related imports:

```typescript
// Adjust the imports near the top of the file:

// Remove from container-runtime.js imports:
//   CONTAINER_HOST_GATEWAY  ← no longer used (containers don't route through the proxy)

// Remove from config.js imports:
//   CREDENTIAL_PROXY_PORT   ← no longer used

// Add to credential-proxy.js imports:
import { detectAuthMode, getAuthSecret } from './credential-proxy.js';
```

**b) Credential injection** — find the block that sets `ANTHROPIC_BASE_URL` to the proxy and replace it with direct injection. Delete the `ANTHROPIC_BASE_URL` push entirely:

```typescript
// DELETE these lines (skill version):
//   args.push(
//     '-e',
//     `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
//   );

// REPLACE the placeholder credential injection:

// Skill version:
//   const authMode = detectAuthMode();
//   if (authMode === 'api-key') {
//     args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
//   } else {
//     args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
//   }

// User version (apply this):
const authMode = detectAuthMode();
if (authMode === 'api-key') {
  args.push('-e', `ANTHROPIC_API_KEY=${getAuthSecret()}`);
} else {
  args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${getAuthSecret()}`);
}
```

### 3. Update `src/index.ts`

Remove the proxy server lifecycle from the orchestrator:

**a) Imports:**

```typescript
// Remove from config.js imports: CREDENTIAL_PROXY_PORT
// Remove this import line entirely:
//   import { startCredentialProxy } from './credential-proxy.js';
// Remove from container-runtime.js imports: PROXY_BIND_HOST
//   (PROXY_BIND_HOST stays exported from container-runtime.ts but is not used here anymore)
```

**b) `main()` function — remove proxy startup:**

```typescript
// DELETE:
//   const proxyServer = await startCredentialProxy(
//     CREDENTIAL_PROXY_PORT,
//     PROXY_BIND_HOST,
//   );
```

**c) Shutdown handler — remove proxy close:**

```typescript
// In the shutdown(signal) function, DELETE:
//   proxyServer.close();
```

---

## Verification

```bash
npm run build
npm test -- credential-proxy
```

A working test case: confirm a container receives the real OAuth token at runtime. With a single chat message:

```bash
# In the container's environment, this should now print the real token (not 'placeholder'):
echo $CLAUDE_CODE_OAUTH_TOKEN
```

---

## Reasoning to retain

Original commit: `2b95b9c fix: pass OAuth token directly to containers instead of proxying`.

The native-credential-proxy skill is conceptually fine for `ANTHROPIC_API_KEY` mode (where the proxy just rewrites a header). But for the `CLAUDE_CODE_OAUTH_TOKEN` flow used by Claude Code's Pro/Max subscription auth, the SDK does an OAuth token-exchange that requires the actual token to reach the SDK process. Routing through a header-rewriting proxy isn't enough — the SDK never sees the real token. Direct injection is simpler and works for both modes.

**Trade-off:** The proxy's value was security (containers never saw real secrets). With direct injection, the secret is in the container's environment. The user accepted this trade-off for their personal-use install, but anyone porting this to a multi-tenant scenario should reconsider.
