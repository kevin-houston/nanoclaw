# 05 — `CONTAINER_ENV_PASSTHROUGH` env forwarding

**Apply when:** Skills have been merged and customizations 02–04 are done. This is independent of any skill.

**Why:** The user maintains arbitrary third-party API keys in `.env` (e.g. `OPENAI_API_KEY`, `FMP_API_KEY`, `QMD_MCP_URL`). They wanted a single config switch to forward a chosen subset of those keys into containers as `-e` flags, without per-key code changes.

**Files affected:**
- `src/config.ts`
- `src/container-runner.ts`

---

## How to apply

### 1. `src/config.ts`

**a)** Add `'CONTAINER_ENV_PASSTHROUGH'` to the env-config read list at the top of the module:

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OLLAMA_ADMIN_TOOLS',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'CONTAINER_ENV_PASSTHROUGH',
]);
```

The exact preceding entries depend on what the new upstream + skills define — just make sure `'CONTAINER_ENV_PASSTHROUGH'` is in the list.

**b)** At the bottom of the file (after the `TIMEZONE` export), add the parsing logic:

```typescript
// Comma-separated list of env var names to forward from .env into containers.
// Example: CONTAINER_ENV_PASSTHROUGH=OPENAI_API_KEY,FMP_API_KEY
const passthroughRaw =
  process.env.CONTAINER_ENV_PASSTHROUGH ||
  envConfig.CONTAINER_ENV_PASSTHROUGH ||
  '';
export const CONTAINER_ENV_PASSTHROUGH: string[] = passthroughRaw
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
```

### 2. `src/container-runner.ts`

**a)** Add to the imports:

```typescript
// In the config.js imports block:
import {
  // ...existing imports...
  CONTAINER_ENV_PASSTHROUGH,
  // ...
} from './config.js';

// Plus:
import { readEnvFile } from './env.js';
```

**b)** Inside `buildContainerArgs(...)`, after the Anthropic credential injection (from `02-oauth-direct-passing.md`) and before the runtime-specific `hostGatewayArgs()` call (or wherever the surrounding skill puts it), add:

```typescript
// Forward additional API keys listed in CONTAINER_ENV_PASSTHROUGH.
if (CONTAINER_ENV_PASSTHROUGH.length > 0) {
  const secrets = readEnvFile(CONTAINER_ENV_PASSTHROUGH);
  for (const key of CONTAINER_ENV_PASSTHROUGH) {
    if (secrets[key]) {
      args.push('-e', `${key}=${secrets[key]}`);
    }
  }
}
```

---

## Verification

```bash
npm run build
```

Behavior test: set `CONTAINER_ENV_PASSTHROUGH=FOO,BAR` and `FOO=hello` in `.env`. Spawn a container and verify it has `FOO=hello` in env but not `BAR` (since `BAR` wasn't set).

---

## Reasoning to retain

Original commit: `455eaf8 feat: forward selected env vars from .env into containers`.

Explicit allowlist (rather than forwarding the whole `.env`) avoids leaking unrelated secrets into the agent's environment. The empty-default keeps it backward-compatible — if you don't set the var, nothing gets forwarded, exactly as before.
