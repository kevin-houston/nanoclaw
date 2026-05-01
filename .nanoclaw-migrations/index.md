# NanoClaw Migration Guide

**Generated:** 2026-04-29T22:15:22-05:00
**Base:** `a81e1651b5e48c9194162ffa2c50a22283d5ecd3` (merge-base with `upstream/main` at extraction time)
**HEAD at generation:** `e681a0a`
**Upstream HEAD at generation:** `34f3612` (v2.0.17)
**Local version:** 1.2.53 (about to migrate to v2)

---

## Migration Plan

This is a **Tier 3** migration. The fork has 8 applied skills and 9 user customizations. Re-applying upstream is a major-version jump (v1 → v2) with several breaking changes.

### Order of operations

1. **Merge skill branches** in this exact order (some have inter-skill conflicts):
   1. `upstream/skill/apple-container`
   2. `upstream/skill/native-credential-proxy` ⚠️ — produces duplicate declarations against apple-container; resolve immediately per `01-skill-interactions.md`
   3. `upstream/skill/channel-formatting`
   4. `upstream/skill/emacs`
   5. `upstream/skill/ollama-tool`
   6. `upstream/skill/qmd`
   7. `upstream/skill/compact`
   8. `telegram/main` (from the `telegram` remote, not `upstream`)

2. **Resolve skill interactions** — see `01-skill-interactions.md`. Do this before any user customizations.

3. **Apply customizations on top of skills** (these modify skill output):
   - `02-oauth-direct-passing.md` — guts the credential proxy that `native-credential-proxy` introduced; replaces with direct token injection.
   - `03-qmd-conditional-mcp.md` — extends `agent-runner` to register a QMD HTTP MCP server.
   - `04-ollama-admin-tools.md` — gates four management tools behind `OLLAMA_ADMIN_TOOLS`.

4. **Apply independent customizations** (not tied to any skill):
   - `05-container-env-passthrough.md` — `CONTAINER_ENV_PASSTHROUGH` env forwarding into containers.
   - `06-container-build.md` — Dockerfile (Python 3.13, ffmpeg, mount fallback) + `build.sh` runtime default.
   - `07-mount-security.md` — string-form `allowedRoots` normalization.
   - `08-gitignore-and-workflows.md` — `.gitignore` `.env*` pattern + delete two GitHub Actions workflows.

5. **Validate:** `npm install && npm run build && npm test` in the worktree.

### Risk areas

- **Upstream v2 architecture rewrite.** `src/router.ts` was rewritten and many files removed (`remote-control.*`, `task-scheduler.*`, `sender-allowlist.*`, `session-cleanup.ts`). Skill branches may not apply cleanly on v2. If a skill merge produces conflicts, **stop and report** rather than guessing — those skills may need their own upstream update.
- **Telegram remote.** The user's `telegram` remote (`github.com/qwibitai/nanoclaw-telegram.git`) is independent of `upstream`. The CHANGELOG flagged channels as moving to a separate `channels` branch in upstream — confirm whether `telegram/main` or `upstream/skill/telegram` (or `add-telegram` skill from the channels branch) is the right source for the v2 fork before merging.
- **OneCLI vs native credential proxy.** The CHANGELOG flagged: *OneCLI Agent Vault replaces the built-in credential proxy*. The user is on `native-credential-proxy` + `apple-container`. The CHANGELOG specifically says Apple Container users must re-merge `skill/apple-container` and run `/convert-to-apple-container` after upgrade. Plan accordingly — do **not** run `/init-onecli`.

### Staging

- After step 1+2, `npm run build` to confirm skills + dedup compile.
- After step 3, build again — the credential-proxy gut is a structural change.
- After step 4, build + test once more.

---

## Applied Skills

These are reapplied by merging the upstream skill branch. The merge commit hashes below were captured in the user's history and are recorded for traceability only — re-merging uses the **current** branch tips.

| Skill | Branch | Original merge commit | Notes |
|---|---|---|---|
| add-apple-container | `upstream/skill/apple-container` | `694a1f1` | Customized via on-top fixes (kept in skill conflict resolution) |
| add-native-credential-proxy | `upstream/skill/native-credential-proxy` | `b16e38d` | User guts the proxy server — see `02-oauth-direct-passing.md` |
| add-channel-formatting | `upstream/skill/channel-formatting` | `4d4e641` | Used as-is |
| add-emacs | `upstream/skill/emacs` | `f8b3841` | Used as-is |
| add-ollama-tool | `upstream/skill/ollama-tool` | `434ebce` | User adds gated admin tools — see `04-ollama-admin-tools.md` |
| add-qmd | `upstream/skill/qmd` | `1ada6d0` | User adds conditional MCP wiring — see `03-qmd-conditional-mcp.md` |
| add-compact | `upstream/skill/compact` | `37b2231` | Used as-is |
| add-telegram | `telegram/main` (remote) | `8a44c21` | Used as-is. **Verify source on v2 — channels may have moved.** |

### Custom (user-created) skills

None. All `.claude/skills/*` directories correspond to upstream skills or operational/utility skills shipped on the main branch (these survive an upstream merge — no reapplication needed).

### Skipped / non-customizations

- **6 duplicate `chore: remove direct pino/pino-pretty dependency` commits** — pino was already removed upstream, so this is a no-op for migration. Skip.
- **`.env.example` `OLLAMA_HOST=` entry** — added by the ollama-tool skill, will return automatically on re-merge.
- **`setup/verify.ts`** — modified by the native-credential-proxy skill (removed `ONECLI_URL` from regex). Returns automatically on re-merge.
- **Version bumps (1.2.28 → 1.2.30)** — not migration-relevant. Upstream's version (2.0.17) wins.
- **Token-count auto-doc commits** — not customizations.
- **`9d8e116 style: prettier reformat mount-security.ts`** — pure formatting, ignored.

---

## Skill Interactions

See `01-skill-interactions.md`. Key interaction:

- `apple-container` and `native-credential-proxy` both declare `CONTAINER_RUNTIME_BIN`, `CONTAINER_HOST_GATEWAY`, and `PROXY_BIND_HOST` in `src/container-runtime.ts`. Without dedup, the file won't compile.

---

## Customizations index

1. [`01-skill-interactions.md`](01-skill-interactions.md) — Resolve apple-container × native-credential-proxy duplicate declarations
2. [`02-oauth-direct-passing.md`](02-oauth-direct-passing.md) — Replace credential proxy server with direct token injection
3. [`03-qmd-conditional-mcp.md`](03-qmd-conditional-mcp.md) — Conditional QMD MCP server registration in agent-runner
4. [`04-ollama-admin-tools.md`](04-ollama-admin-tools.md) — Gated ollama model management tools
5. [`05-container-env-passthrough.md`](05-container-env-passthrough.md) — `CONTAINER_ENV_PASSTHROUGH` env forwarding
6. [`06-container-build.md`](06-container-build.md) — Dockerfile (Python 3.13, ffmpeg, mount fallback) + build.sh
7. [`07-mount-security.md`](07-mount-security.md) — `allowedRoots` string-form normalization
8. [`08-gitignore-and-workflows.md`](08-gitignore-and-workflows.md) — `.gitignore` `.env*`, delete two workflows
