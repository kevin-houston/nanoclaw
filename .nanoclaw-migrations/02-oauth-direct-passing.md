# 02 — OAuth direct passing (replace credential proxy server)

> **v2 update (applied 2026-05-01):** This document was originally written for v1, where the customization was to gut the `native-credential-proxy` skill's HTTP server. v2 retired that skill in favor of OneCLI Vault. The same auth problem still exists — OneCLI's vault secrets inject as `x-api-key` headers, which OAuth tokens (`sk-ant-oat01-…`) cannot use — so a smaller v2-shaped variant was applied to `src/container-runner.ts`: read `CLAUDE_CODE_OAUTH_TOKEN` from `.env` after `onecli.applyContainerConfig`, then push `-e ANTHROPIC_API_KEY=` and `-e CLAUDE_CODE_OAUTH_TOKEN=…` so Docker's last-wins env semantics override OneCLI's placeholder. See commit `fe18ce9`. The original v1 procedure below is kept for historical reference.
>
> **v2 minimal patch:**
> ```typescript
> // After onecli.applyContainerConfig(...) in buildContainerArgs:
> const { CLAUDE_CODE_OAUTH_TOKEN } = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
> if (CLAUDE_CODE_OAUTH_TOKEN) {
>   args.push('-e', 'ANTHROPIC_API_KEY=');
>   args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}`);
> }
> ```

---

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
