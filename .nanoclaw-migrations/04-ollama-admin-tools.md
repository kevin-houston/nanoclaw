# 04 — Ollama admin tools (gated)

**Apply when:** Skill `upstream/skill/ollama-tool` has been merged.

**Why:** The base ollama-tool skill exposes inference tools only. The user adds four model-management tools (pull, delete, show, list-running) gated behind an `OLLAMA_ADMIN_TOOLS=true` flag so they aren't accidentally available in normal use.

**Files affected:**
- `container/agent-runner/src/ollama-mcp-stdio.ts`

---

## How to apply

### 1. Add the flag at the top of the module

After the existing imports, add:

```typescript
const OLLAMA_ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS === 'true';
```

### 2. Append the gated tool block at the end of the tool-registration sequence

After all the existing `server.tool(...)` calls (the inference tools shipped by the skill), and before `await server.connect(transport)` or whatever closes out registration, add this block. The block defines four management tools — all wrapped in a single `if (OLLAMA_ADMIN_TOOLS)` guard:

```typescript
if (OLLAMA_ADMIN_TOOLS) {
  server.tool(
    'ollama_pull_model',
    'Pull (download) a model from the Ollama registry by name. Returns the final status once the pull is complete. Use model names like "llama3.2", "mistral", "gemma2:9b".',
    {
      model: z
        .string()
        .describe(
          'Model name to pull, e.g. "llama3.2", "mistral", "gemma2:9b"',
        ),
    },
    async (args) => {
      log(`Pulling model: ${args.model}...`);
      writeStatus('pulling', `Pulling ${args.model}`);
      try {
        const res = await ollamaFetch('/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model, stream: false }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }
        const data = (await res.json()) as { status: string };
        log(`Pull complete: ${args.model} — ${data.status}`);
        writeStatus('done', `Pulled ${args.model}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Pull complete: ${args.model} — ${data.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to pull model: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_delete_model',
    'Delete a locally installed Ollama model to free up disk space.',
    {
      model: z
        .string()
        .describe('Model name to delete, e.g. "llama3.2", "mistral:latest"'),
    },
    async (args) => {
      log(`Deleting model: ${args.model}...`);
      writeStatus('deleting', `Deleting ${args.model}`);
      try {
        const res = await ollamaFetch('/api/delete', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }
        log(`Deleted: ${args.model}`);
        writeStatus('done', `Deleted ${args.model}`);
        return {
          content: [
            { type: 'text' as const, text: `Deleted model: ${args.model}` },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete model: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_show_model',
    'Show details for a locally installed Ollama model: modelfile, parameters, template, system prompt, and architecture info.',
    {
      model: z
        .string()
        .describe('Model name to inspect, e.g. "llama3.2", "mistral:latest"'),
    },
    async (args) => {
      log(`Showing model info: ${args.model}...`);
      try {
        const res = await ollamaFetch('/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: args.model }),
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama error (${res.status}): ${errorText}`,
              },
            ],
            isError: true,
          };
        }
        const data = await res.json();
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to show model info: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_list_running',
    'List Ollama models currently loaded in memory with their memory usage, processor type (CPU/GPU), and time until they are unloaded.',
    {},
    async () => {
      log('Listing running models...');
      try {
        const res = await ollamaFetch('/api/ps');
        if (!res.ok) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Ollama API error: ${res.status} ${res.statusText}`,
              },
            ],
            isError: true,
          };
        }
        const data = (await res.json()) as {
          models?: Array<{
            name: string;
            size: number;
            size_vram: number;
            processor: string;
            expires_at: string;
          }>;
        };
        const models = data.models || [];
        if (models.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No models currently loaded in memory.',
              },
            ],
          };
        }
        const list = models
          .map((m) => {
            const size = m.size_vram > 0 ? m.size_vram : m.size;
            return `- ${m.name} (${(size / 1e9).toFixed(1)}GB ${m.processor}, unloads at ${m.expires_at})`;
          })
          .join('\n');
        log(`${models.length} model(s) running`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Models loaded in memory:\n${list}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to list running models: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  log('Admin tools enabled (pull, delete, show, list-running)');
}
```

### 3. Wire `OLLAMA_ADMIN_TOOLS` through the host → container

For the flag to take effect, the host must forward it. The skill's container-runner step (or, post-customization, `src/container-runner.ts`) needs to push it as a `-e` flag when set:

```typescript
// Confirm src/container-runner.ts contains:
import { OLLAMA_ADMIN_TOOLS } from './config.js';
// ...
if (OLLAMA_ADMIN_TOOLS) {
  args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
}
```

If `src/config.ts` doesn't already export `OLLAMA_ADMIN_TOOLS` after the skill merge, add it:

```typescript
// In src/config.ts
const envConfig = readEnvFile([
  // ...
  'OLLAMA_ADMIN_TOOLS',
  // ...
]);

export const OLLAMA_ADMIN_TOOLS =
  process.env.OLLAMA_ADMIN_TOOLS === 'true' ||
  envConfig.OLLAMA_ADMIN_TOOLS === 'true';
```

Most likely the ollama-tool skill already adds these — verify before duplicating.

---

## Verification

Build the container module:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Set `OLLAMA_ADMIN_TOOLS=true` in `.env` and verify the four tools appear in the agent's tool list at runtime. With the flag unset, the four tools must not be registered.

---

## Reasoning to retain

Original commit: `5743a48 feat: add gated model management tools to Ollama MCP server`.

These tools have side effects (pull a multi-GB file, delete a local model). Gating them behind a flag keeps casual chat sessions from accidentally invoking them. The user wants the option but not always the access.
