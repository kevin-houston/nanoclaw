/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
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

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
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
async function attemptSetup(name: string, adapter: ChannelAdapter, setup: ChannelSetup): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
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
      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started after background retry', {
        channel: name,
        type: adapter.channelType,
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
