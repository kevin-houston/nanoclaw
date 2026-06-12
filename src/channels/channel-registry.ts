/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];
const BACKGROUND_RETRY_INITIAL_MS = 30_000;
const BACKGROUND_RETRY_MAX_MS = 300_000;

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();
const pendingRetries = new Map<string, NodeJS.Timeout>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by its EXACT registry key (instance name; default
 *  instances are keyed by channelType itself). No channelType fallback —
 *  callers that address a specific instance (outbound delivery, typing)
 *  must never be rerouted through a sibling instance: that would send
 *  through the wrong bot identity with the wrong token. A missing key
 *  means the owning adapter is offline; callers apply their normal
 *  offline-adapter handling. */
export function getChannelAdapterExact(key: string): ChannelAdapter | undefined {
  return activeAdapters.get(key);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. The fallback exists ONLY for channelType-only callers
 *  (user-id prefix resolution and cold DMs in user-dm.ts, approval delivery
 *  in channel-approval.ts, the router's thread-policy probe when an event
 *  carries no instance) — they must still resolve when every instance of a
 *  platform is named. First registered wins (Map insertion order,
 *  deterministic). Default instances are keyed by channelType itself, so
 *  single-instance installs always hit the exact-key path. Instance-addressed
 *  dispatch (delivery, typing) must use getChannelAdapterExact instead. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const [registryKey, adapter] of activeAdapters) {
    if (adapter.channelType === key) {
      log.warn('Channel adapter fallback: requested key resolved through a differently-keyed instance', {
        requested: key,
        resolvedKey: registryKey,
      });
      return adapter;
    }
  }
  return undefined;
}

/**
 * Build the host's outbound delivery bridge: dispatches delivery-poll and
 * typing traffic into the adapter registry. Resolution is EXACT-key only —
 * `instance ?? channelType`. For default-instance messaging_groups rows the
 * stored instance IS the channelType, which matches default-registered
 * adapters, so single-instance behavior is unchanged. A named instance whose
 * adapter is offline gets the normal offline-adapter handling (warn + drop
 * into the delivery retry path) — never a cross-identity send through a
 * sibling bot of the same platform.
 */
export function createChannelDeliveryAdapter(): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType, instance });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      await attemptSetup(name, adapter, setup);
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/**
 * Run `adapter.setup(setup)` with retry. Transient NetworkErrors get a few inline
 * retries first so quick hiccups (e.g. Telegram `deleteWebhook` DNS flap at boot)
 * resolve before `initChannelAdapters` returns. If inline retries exhaust, fall
 * back to a background retry loop so longer outages don't permanently disable the
 * channel — when the network recovers, the adapter rejoins on its own. Misconfigs
 * (bad tokens, etc.) still fail fast since only NetworkError is retried.
 */
/** Register a successfully-set-up adapter under its instance key. Adapters key
 *  by instance (default instance = channelType), so N instances of one platform
 *  coexist. Duplicate keys warn instead of throwing — boot stays resilient,
 *  matching the historical silent last-write-wins, but now visibly. */
function registerActiveAdapter(name: string, adapter: ChannelAdapter): void {
  const key = adapter.instance ?? adapter.channelType;
  if (activeAdapters.has(key)) {
    log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
  }
  activeAdapters.set(key, adapter);
}

async function attemptSetup(name: string, adapter: ChannelAdapter, setup: ChannelSetup): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      registerActiveAdapter(name, adapter);
      log.info('Channel adapter started', {
        channel: name,
        type: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
      });
      return;
    } catch (err) {
      if (!isNetworkError(err)) throw err;
      if (attempt >= SETUP_RETRY_DELAYS_MS.length) {
        scheduleBackgroundRetry(name, adapter, setup, BACKGROUND_RETRY_INITIAL_MS, err.message);
        return;
      }
      const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
      log.warn('Channel adapter setup failed with network error, retrying', {
        channel: name,
        attempt: attempt + 1,
        delayMs: delay,
        err: err.message,
      });
      await sleep(delay);
      attempt += 1;
    }
  }
}

function scheduleBackgroundRetry(
  name: string,
  adapter: ChannelAdapter,
  setup: ChannelSetup,
  delayMs: number,
  lastErr: string,
): void {
  log.warn('Channel adapter setup deferred to background retry', {
    channel: name,
    delayMs,
    err: lastErr,
  });
  const handle = setTimeout(async () => {
    pendingRetries.delete(name);
    try {
      await adapter.setup(setup);
      registerActiveAdapter(name, adapter);
      log.info('Channel adapter started after background retry', {
        channel: name,
        type: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        const nextDelay = Math.min(delayMs * 2, BACKGROUND_RETRY_MAX_MS);
        scheduleBackgroundRetry(name, adapter, setup, nextDelay, err.message);
      } else {
        log.error('Channel adapter background retry failed (non-network error, giving up)', {
          channel: name,
          err,
        });
      }
    }
  }, delayMs);
  handle.unref?.();
  pendingRetries.set(name, handle);
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const handle of pendingRetries.values()) clearTimeout(handle);
  pendingRetries.clear();
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}

/** Test-only: clear all module-level state (registry, active, pending). */
export function __resetChannelRegistryForTests(): void {
  for (const handle of pendingRetries.values()) clearTimeout(handle);
  pendingRetries.clear();
  activeAdapters.clear();
  registry.clear();
}
