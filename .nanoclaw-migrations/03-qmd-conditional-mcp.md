# 03 — QMD conditional MCP server registration

**Apply when:** Skill `upstream/skill/qmd` has been merged.

**Why:** The skill installs the QMD CLI in the container and ships a `container/skills/qmd/` skill, but it stops short of wiring an MCP server into `agent-runner` so the agent can call QMD as a tool. The user adds two things to `container/agent-runner/src/index.ts`:

1. Whitelist `mcp__qmd__*` tools so the agent can use them.
2. Conditionally register an HTTP MCP server pointing at `process.env.QMD_MCP_URL` — only when that env var is set, so users without QMD don't see a broken server.

**Files affected:**
- `container/agent-runner/src/index.ts`

---

## How to apply

In `container/agent-runner/src/index.ts`, locate the agent options object passed to the Claude Agent SDK. There will be an `allowedTools: [...]` array and a sibling `mcpServers: { ... }` object.

### 1. Add `mcp__qmd__*` to `allowedTools`

The full array (after edit) should look like this. The new entry is on the last line before the closing bracket:

```typescript
allowedTools: [
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__qmd__*',
],
```

Insert `'mcp__qmd__*'` after `'mcp__nanoclaw__*'`. If the array on the new upstream has a different shape, just add `'mcp__qmd__*'` once, near the other `mcp__*` patterns.

### 2. Conditionally register the QMD HTTP MCP server

In the same `mcpServers` object, append a conditional spread that registers `qmd` only when `QMD_MCP_URL` is set:

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
  ...(process.env.QMD_MCP_URL
    ? {
        qmd: {
          type: 'http' as const,
          url: process.env.QMD_MCP_URL,
        },
      }
    : {}),
},
```

The `as const` on `type: 'http'` is required for TypeScript to narrow the union type — without it, you'll get a type error at compile time.

---

## Verification

```bash
cd container/agent-runner && npx tsc --noEmit
```

If `QMD_MCP_URL` is set in the host environment, it must be passed into the container as `-e QMD_MCP_URL=...` for this to take effect at runtime. The user does this via `CONTAINER_ENV_PASSTHROUGH` (see `05-container-env-passthrough.md`):

```
# In .env on the host:
CONTAINER_ENV_PASSTHROUGH=QMD_MCP_URL,OPENAI_API_KEY,FMP_API_KEY
QMD_MCP_URL=https://qmd.example/mcp
```

When QMD_MCP_URL is unset, the spread evaluates to `{}` and `mcpServers` only has `nanoclaw` — no broken server.

---

## Reasoning to retain

Original commit: `9618043 feat: add QMD integration (Dockerfile, agent-runner, container skill)`. The Dockerfile and container/skills/qmd/SKILL.md parts were upstreamed as `skill/qmd`, but the agent-runner wiring was kept user-side because it depends on a runtime env var the user controls.
