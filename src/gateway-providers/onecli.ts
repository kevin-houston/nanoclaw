/**
 * OneCLI contributes typed environment and read-only file mounts, before spec
 * validation. Persist its CA and credential stubs across host restarts; the
 * SDK's argv helper stages shared paths in the host temporary directory.
 */
import { OneCLI, type ContainerConfig } from '@onecli-sh/sdk';

import { DATA_DIR, ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import type { MountSpec } from '../drivers/types.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayApprovalSource,
  type GatewayContribution,
} from './gateway-provider-registry.js';

import { combinedCaBundle, stageOnecliFile } from './onecli-files.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Convert the typed SDK response without its shared temporary-file side effects. */
function contributionFromConfig(config: ContainerConfig, groupScope: string): GatewayContribution {
  const env = { ...config.env };
  const mounts: MountSpec[] = [];
  const mount = (kind: 'ca' | 'combined' | 'stub', content: string, containerPath: string) => {
    mounts.push({
      class: 'allowlisted-extra',
      hostPath: stageOnecliFile(DATA_DIR, kind, content),
      containerPath,
      mode: 'ro',
      groupScope,
    });
  };
  mount('ca', config.caCertificate, config.caCertificateContainerPath);
  const combined = combinedCaBundle(config.caCertificate);
  if (combined !== undefined) {
    const containerPath = '/tmp/onecli-combined-ca.pem';
    mount('combined', combined, containerPath);
    env.SSL_CERT_FILE = containerPath;
    env.DENO_CERT = containerPath;
  }
  for (const stub of config.credentialStubs ?? []) {
    mount('stub', stub.content, stub.containerPath);
  }
  return { env, mounts };
}

/**
 * Gateway stubs that must not reach a Claude container with a non-empty value.
 *
 * The gateway advertises one placeholder env var per vault secret so agent code
 * that reads `os.environ[...]` finds *a* value. For `api.anthropic.com` that
 * stub is `ANTHROPIC_API_KEY=placeholder`, and it is actively harmful: the
 * Agent SDK reads a non-empty `ANTHROPIC_API_KEY` as "authenticate with
 * `x-api-key`" and sends `x-api-key: placeholder`. Our vault secret is
 * header-injected as `Authorization: Bearer <oauth token>`, so the gateway ADDS
 * the real Authorization header but leaves the bogus `x-api-key` beside it —
 * and Anthropic honours `x-api-key` first and answers 401, while the gateway
 * log still reads `injections_applied=1` as though auth had succeeded.
 *
 * Verified by A/B on 2026-08-29: dropping the stub → 8/8 `status=200`;
 * restoring it → immediate 401. The peer install (nc/nc2/nanoclaw) never hit
 * this because its `ANTHROPIC_API_KEY` arrives EMPTY, which the SDK treats as
 * unset — the same end state this drop produces.
 *
 * Only the stub value is dropped. A real key would be a credential riding env,
 * which the spec's admission check refuses anyway.
 */
const DROPPED_GATEWAY_ENV = new Set(['ANTHROPIC_API_KEY']);

export function withoutConflictingStubs(env: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (DROPPED_GATEWAY_ENV.has(name) && value === 'placeholder') {
      log.debug('Dropped gateway stub that would shadow the injected auth header', { name });
      continue;
    }
    kept[name] = value;
  }
  return kept;
}

/**
 * OneCLI's approvals capability: the SDK's manual-approval long-poll, mapped
 * to the neutral request shape. `listPending`/`decide` are deliberately
 * absent — the gateway does not redeliver un-decided requests on reconnect
 * and the SDK exposes no late-decision surface, so the capability flags
 * honestly say so and the approvals module degrades accordingly.
 */
function onecliApprovalSource(): GatewayApprovalSource {
  return {
    subscribe(handler) {
      const handle = onecli.configureManualApproval(async (request) =>
        // The SDK's ApprovalRequest is structurally the neutral shape (the
        // hosted gateway's `summary` rides as an extra field).
        handler(request as unknown as GatewayApprovalRequest),
      );
      return { stop: () => handle.stop() };
    },
  };
}

registerGatewayProvider('onecli', () => ({
  kind: 'onecli',
  approvals: onecliApprovalSource,
  async contribute({ key, groupName }) {
    // OneCLI agent identifier is always the agent group id — stable across
    // sessions and reversible via getAgentGroup() for approval routing.
    await onecli.ensureAgent({ name: groupName, identifier: key.agentGroupId });
    const config = await onecli.getContainerConfig({ agent: key.agentGroupId });
    const contribution = contributionFromConfig(config, key.agentGroupId);
    log.info('OneCLI gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return { ...contribution, env: withoutConflictingStubs(contribution.env ?? {}) };
  },
}));
