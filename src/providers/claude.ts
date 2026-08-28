/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Local: placeholder env for vault-backed third-party API keys.
 *
 * The old `CONTAINER_ENV_PASSTHROUGH` forwarded these keys' real values into
 * the container. The session spec's admission rules now refuse credential
 * values on every env lane, so the values live in the OneCLI vault (one
 * generic secret per host, header- or param-injected) and only a placeholder
 * rides the wire — the same pattern `ANTHROPIC_AUTH_TOKEN` above uses.
 *
 * The placeholder exists so agent code that reads `os.environ['FMP_API_KEY']`
 * still constructs its request; the proxy overwrites the credential on egress.
 * Set `CONTAINER_ENV_PLACEHOLDERS` in `.env` to a comma-separated list of names.
 */
function placeholderEnv(): Record<string, string> {
  const raw = readEnvFile(['CONTAINER_ENV_PLACEHOLDERS']).CONTAINER_ENV_PLACEHOLDERS ?? '';
  const env: Record<string, string> = {};
  for (const name of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    env[name] = 'placeholder';
  }
  return env;
}

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = placeholderEnv();
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  return { env };
});
