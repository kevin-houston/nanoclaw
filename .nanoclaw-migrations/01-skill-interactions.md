# 01 — Skill Interactions: apple-container × native-credential-proxy

**Apply when:** Both `upstream/skill/apple-container` and `upstream/skill/native-credential-proxy` have been merged into the upgrade branch. The native-credential-proxy merge will produce conflicts in `src/container-runtime.ts` (and possibly `src/container-runner.test.ts`) — resolve them per this document.

**Why:** Both skills declare the same module-level exports in `src/container-runtime.ts`, originally written assuming each is the sole skill applied. The user's fork resolved this with platform-aware unified logic that supports both runtimes.

**Files affected:**
- `src/container-runtime.ts`
- `src/container-runner.test.ts`

---

## What goes wrong without this resolution

After merging both skill branches, `src/container-runtime.ts` ends up with two declarations of each:

- `CONTAINER_RUNTIME_BIN` (apple-container hardcodes `'container'`; native-credential-proxy keeps Docker-oriented logic)
- `CONTAINER_HOST_GATEWAY` (apple-container detects an Apple bridge IP; native-credential-proxy uses `'host.docker.internal'`)
- `PROXY_BIND_HOST` (apple-container throws if `CREDENTIAL_PROXY_HOST` is unset; native-credential-proxy uses fallback detection)
- A `detectHostGateway()` function from apple-container that conflicts conceptually with native-credential-proxy's gateway approach

The TypeScript build fails with `Cannot redeclare exported variable` errors.

---

## How to apply

In `src/container-runtime.ts`, replace **both** sets of duplicated declarations with the unified, platform-aware versions below.

### 1. `CONTAINER_RUNTIME_BIN` — platform-aware with env override

```typescript
// Picks the runtime based on platform, with CONTAINER_RUNTIME env override.
// Apple Container is the default on macOS; Docker is the default elsewhere.
export const CONTAINER_RUNTIME_BIN =
  process.env.CONTAINER_RUNTIME ||
  (os.platform() === 'darwin' ? 'container' : 'docker');
```

### 2. `CONTAINER_HOST_GATEWAY` — runtime-conditional

```typescript
export const CONTAINER_HOST_GATEWAY =
  CONTAINER_RUNTIME_BIN === 'container'
    ? detectAppleHostGateway()
    : 'host.docker.internal';
```

### 3. `detectAppleHostGateway` — rename and keep one copy

Delete `detectHostGateway` from apple-container's contribution. Replace with:

```typescript
function detectAppleHostGateway(): string {
  // Apple Container on macOS: containers reach the host via the bridge gateway.
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '192.168.64.1';
}
```

### 4. `PROXY_BIND_HOST` — fallback detection, no throw

Delete the apple-container variant that throws when `CREDENTIAL_PROXY_HOST` is unset. Keep the native-credential-proxy version's spirit (env override + detection):

```typescript
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}
```

### 5. Required imports

Confirm the file imports both modules (one or the other was already there from the skills):

```typescript
import os from 'os';
import fs from 'fs';
```

### 6. Test mock fix

In `src/container-runner.test.ts`, the config mock used by these tests must include `OLLAMA_ADMIN_TOOLS: false`. After the ollama-tool skill is also merged (which adds the import), tests expecting a config object for the runner break. Add this key to the mock:

```typescript
// Wherever the config mock is defined for container-runner.test.ts:
{
  // ...existing mock fields...
  OLLAMA_ADMIN_TOOLS: false,
}
```

---

## Verification

After applying:

```bash
npm run build
```

The build must pass with no `Cannot redeclare` errors. If it doesn't, the dedup is incomplete — check for other duplicated symbols introduced by either skill.

---

## Reasoning to retain (in case future-you needs to adapt this)

The user originally fixed this as commit `4abc661 fix: resolve duplicate declarations from apple-container + native-credential-proxy merge`. The decisions encoded above:

- `CONTAINER_RUNTIME` env override allows users to force a runtime regardless of platform (CI on Linux, Apple Container on dev box, etc.).
- `detectAppleHostGateway` is renamed to make it obvious it's Apple-only — the Docker side has a hardcoded gateway.
- `PROXY_BIND_HOST` fallback to `127.0.0.1` on macOS and detected `docker0` IP on Linux is a deliberate softening of the apple-container skill's hard requirement that broke headless Linux setups.
