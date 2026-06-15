import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// OneCLI SDK constructs a client at module load — stub it so the import
// of container-runner doesn't try to talk to the real gateway during tests.
// Must be a class (or `function`) so `new OneCLI(...)` works; an arrow-returning
// object is not a constructor.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn();
    applyContainerConfig = vi.fn();
    configureManualApproval = vi.fn();
  },
}));

// Quiet the warn paths in moveEnvToFile so the test output stays clean.
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { moveEnvToFile, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

const PREFIX = ['run', '--rm', '--name', 'test-container', '--label', 'test-label'];

describe('moveEnvToFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moveenvfile-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('moves every -e KEY=value pair into the env-file and drops it from argv', () => {
    const input = [...PREFIX, '-e', 'A=one', '-e', 'B=two', '--entrypoint', 'bash', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);

    expect(args).not.toContain('-e');
    const idx = args.indexOf('--env-file');
    expect(idx).toBeGreaterThan(-1);
    const envPath = args[idx + 1];
    expect(envPath).toBe(path.join(tmpDir, '.env.container'));

    const lines = fs.readFileSync(envPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.sort()).toEqual(['A=one', 'B=two']);

    cleanup();
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it('inserts --env-file after the --label value, not between --label and its argument', () => {
    // Regression: splice(5, …) would put --env-file at index 5, splitting
    // --label from its value and breaking the docker argv. Must be index 6.
    const input = [...PREFIX, '-e', 'A=one', '--entrypoint', 'bash', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);

    expect(args.slice(0, 6)).toEqual(PREFIX);
    expect(args[6]).toBe('--env-file');
    expect(args[7]).toBe(path.join(tmpDir, '.env.container'));
    expect(args.slice(8)).toEqual(['--entrypoint', 'bash', 'image:tag']);

    cleanup();
  });

  it('returns argv unchanged and a no-op cleanup when there are no -e flags', () => {
    const input = [...PREFIX, '--entrypoint', 'bash', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);

    expect(args).toEqual(input);
    expect(fs.existsSync(path.join(tmpDir, '.env.container'))).toBe(false);
    expect(() => cleanup()).not.toThrow();
  });

  it('preserves empty values (KEY= meaning "clear")', () => {
    const input = [...PREFIX, '-e', 'ANTHROPIC_API_KEY=', '-e', 'OTHER=val', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);
    const envPath = args[args.indexOf('--env-file') + 1];
    const content = fs.readFileSync(envPath, 'utf8');

    expect(content).toMatch(/^ANTHROPIC_API_KEY=$/m);
    expect(content).toMatch(/^OTHER=val$/m);
    cleanup();
  });

  it('keeps bare -e KEY (no =) inline because env-file cannot represent host-passthrough', () => {
    const input = [...PREFIX, '-e', 'PASSTHROUGH_KEY', '-e', 'A=val', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);

    const eIdx = args.indexOf('-e');
    expect(eIdx).toBeGreaterThan(-1);
    expect(args[eIdx + 1]).toBe('PASSTHROUGH_KEY');

    const envPath = args[args.indexOf('--env-file') + 1];
    expect(fs.readFileSync(envPath, 'utf8')).toContain('A=val');
    cleanup();
  });

  it('throws on values with embedded newlines without leaking the value into the error', () => {
    const input = [...PREFIX, '-e', 'TOKEN=secret\nleaked', 'image:tag'];

    expect(() => moveEnvToFile(input, tmpDir)).toThrow(/TOKEN/);

    try {
      moveEnvToFile(input, tmpDir);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain('secret');
      expect(msg).not.toContain('leaked');
    }
  });

  it('writes the env-file with mode 0600', () => {
    const input = [...PREFIX, '-e', 'A=one', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);
    const envPath = args[args.indexOf('--env-file') + 1];

    const stat = fs.statSync(envPath);
    expect(stat.mode & 0o777).toBe(0o600);
    cleanup();
  });

  it('cleanup is idempotent', () => {
    const input = [...PREFIX, '-e', 'A=one', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);
    const envPath = args[args.indexOf('--env-file') + 1];

    cleanup();
    expect(fs.existsSync(envPath)).toBe(false);
    expect(() => cleanup()).not.toThrow();
  });

  it('cleanup handles an externally-deleted file without throwing', () => {
    const input = [...PREFIX, '-e', 'A=one', 'image:tag'];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);
    const envPath = args[args.indexOf('--env-file') + 1];

    fs.unlinkSync(envPath);
    expect(() => cleanup()).not.toThrow();
  });

  it('handles a mix of three -e flags interleaved with other args', () => {
    const input = [
      ...PREFIX,
      '-e',
      'A=1',
      '--add-host=host.docker.internal:host-gateway',
      '-e',
      'B=2',
      '-v',
      '/host:/container',
      '-e',
      'C=3',
      'image:tag',
    ];
    const { args, cleanup } = moveEnvToFile(input, tmpDir);

    expect(args).not.toContain('-e');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    const vIdx = args.indexOf('-v');
    expect(args[vIdx + 1]).toBe('/host:/container');

    const envPath = args[args.indexOf('--env-file') + 1];
    const lines = fs.readFileSync(envPath, 'utf8').split('\n').filter(Boolean).sort();
    expect(lines).toEqual(['A=1', 'B=2', 'C=3']);

    cleanup();
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});
