import { execFileSync, execSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoisted — must appear before any imports of the modules they replace) ---

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
}));
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Stub filesystem so tests never touch disk.
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

// ---------------------------------------------------------------------------
// Helpers

/** Make an HTTP request to the test server; returns status code and parsed body. */
async function req(
  port: number,
  method: string,
  reqPath: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const request = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

/** Get the bound port from the adapter's HTTP server (cast to internal shape). */
function boundPort(adapter: ChannelAdapter): number {
  return ((adapter as unknown as { _server: http.Server })._server.address() as AddressInfo).port;
}

/** Build a minimal ChannelSetup stub. */
function makeSetup(): { setup: ChannelSetup; onInbound: ReturnType<typeof vi.fn> } {
  const onInbound = vi.fn();
  const setup: ChannelSetup = {
    onInbound,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
  return { setup, onInbound };
}

/** Create an emacs adapter with port 0 (OS picks a free port). */
async function makeConnectedAdapter(
  authToken?: string,
): Promise<{ adapter: ChannelAdapter; setup: ChannelSetup; onInbound: ReturnType<typeof vi.fn> }> {
  process.env.EMACS_CHANNEL_PORT = '0';
  if (authToken !== undefined) process.env.EMACS_AUTH_TOKEN = authToken;
  else delete process.env.EMACS_AUTH_TOKEN;

  // Re-import to pick up fresh env (module is already loaded, call factory directly)
  const { createEmacsAdapter } = await import('./emacs.js');
  const adapter = createEmacsAdapter();
  const { setup, onInbound } = makeSetup();
  // Expose server for boundPort
  await adapter.setup(setup);
  return { adapter, setup, onInbound };
}

// ---------------------------------------------------------------------------

describe('emacs channel adapter', () => {
  afterEach(async () => {
    delete process.env.EMACS_CHANNEL_PORT;
    delete process.env.EMACS_AUTH_TOKEN;
  });

  describe('lifecycle', () => {
    it('isConnected returns false before setup', async () => {
      const { createEmacsAdapter } = await import('./emacs.js');
      const adapter = createEmacsAdapter();
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected returns true after setup', async () => {
      const { adapter } = await makeConnectedAdapter();
      expect(adapter.isConnected()).toBe(true);
      await adapter.teardown();
    });

    it('isConnected returns false after teardown', async () => {
      const { adapter } = await makeConnectedAdapter();
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown is safe when not connected', async () => {
      const { createEmacsAdapter } = await import('./emacs.js');
      const adapter = createEmacsAdapter();
      await expect(adapter.teardown()).resolves.not.toThrow();
    });
  });

  describe('POST /api/message', () => {
    let adapter: ChannelAdapter;
    let port: number;
    let onInbound: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      ({ adapter, onInbound } = await makeConnectedAdapter());
      port = boundPort(adapter);
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('returns 200 with messageId and timestamp for valid text', async () => {
      const { status, data } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hello' }));
      expect(status).toBe(200);
      expect(data).toHaveProperty('messageId');
      expect(data).toHaveProperty('timestamp');
    });

    it('calls onInbound with correct structure', async () => {
      await req(port, 'POST', '/api/message', JSON.stringify({ text: 'ping' }));
      expect(onInbound).toHaveBeenCalledWith(
        'emacs:default',
        null,
        expect.objectContaining({
          kind: 'chat',
          content: expect.objectContaining({ text: 'ping', sender: 'emacs' }),
        }),
      );
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '' }));
      expect(status).toBe(400);
    });

    it('returns 400 for whitespace-only text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '   ' }));
      expect(status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(port, 'POST', '/api/unknown', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/messages', () => {
    let adapter: ChannelAdapter;
    let port: number;

    beforeEach(async () => {
      ({ adapter } = await makeConnectedAdapter());
      port = boundPort(adapter);
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('returns empty messages array when nothing buffered', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('returns messages added via deliver()', async () => {
      await adapter.deliver('emacs:default', null, { kind: 'chat', content: { text: 'hello back' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: Array<{ text: string }> }).messages).toHaveLength(1);
      expect((data as { messages: Array<{ text: string }> }).messages[0].text).toBe('hello back');
    });

    it('filters messages at or before the since timestamp', async () => {
      await adapter.deliver('emacs:default', null, { kind: 'chat', content: { text: 'old' } });
      const since = Date.now();
      await new Promise((r) => setTimeout(r, 2));
      await adapter.deliver('emacs:default', null, { kind: 'chat', content: { text: 'new' } });
      const { data } = await req(port, 'GET', `/api/messages?since=${since}`);
      const texts = (data as { messages: Array<{ text: string }> }).messages.map((m) => m.text);
      expect(texts).not.toContain('old');
      expect(texts).toContain('new');
    });
  });

  describe('authentication', () => {
    let adapter: ChannelAdapter;
    let port: number;

    beforeEach(async () => {
      ({ adapter } = await makeConnectedAdapter('secret'));
      port = boundPort(adapter);
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('rejects POST without Authorization header (401)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(401);
    });

    it('rejects POST with wrong token (401)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer wrong',
      });
      expect(status).toBe(401);
    });

    it('accepts POST with correct Bearer token (200)', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer secret',
      });
      expect(status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// nanoclaw--md-to-org-regex (Emacs Lisp, tested via emacs --batch)

function emacsAvailable(): boolean {
  try {
    execSync('emacs --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function mdToOrg(input: string): string {
  const elFile = path.resolve('emacs/nanoclaw.el');
  const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return execFileSync(
    'emacs',
    ['--batch', '--load', elFile, '--eval', `(princ (nanoclaw--md-to-org-regex "${escaped}"))`],
    {
      encoding: 'utf8',
    },
  );
}

describe.skipIf(!emacsAvailable())('nanoclaw--md-to-org-regex', () => {
  it('converts bold **text** → *text*', () => {
    expect(mdToOrg('**hello**')).toBe('*hello*');
  });

  it('converts italic *text* → /text/', () => {
    expect(mdToOrg('*hello*')).toBe('/hello/');
  });

  it('handles bold before italic in the same string', () => {
    expect(mdToOrg('**bold** and *italic*')).toBe('*bold* and /italic/');
  });

  it('converts strikethrough ~~text~~ → +text+', () => {
    expect(mdToOrg('~~gone~~')).toBe('+gone+');
  });

  it('converts underline __text__ → _text_', () => {
    expect(mdToOrg('__under__')).toBe('_under_');
  });

  it('converts inline code `code` → ~code~', () => {
    expect(mdToOrg('`foo()`')).toBe('~foo()~');
  });

  it('converts fenced code block with language', () => {
    expect(mdToOrg('```typescript\nconst x = 1;\n```')).toBe('#+begin_src typescript\nconst x = 1;\n#+end_src');
  });

  it('converts fenced code block without language', () => {
    expect(mdToOrg('```\nhello\n```')).toBe('#+begin_src text\nhello\n#+end_src');
  });

  it('converts ## heading → ** heading', () => {
    expect(mdToOrg('## Section')).toBe('** Section');
  });

  it('converts ### heading → *** heading', () => {
    expect(mdToOrg('### Deep')).toBe('*** Deep');
  });

  it('leaves list items unchanged', () => {
    expect(mdToOrg('- item one')).toBe('- item one');
  });

  it('converts links [text](url) → [[url][text]]', () => {
    expect(mdToOrg('[NanoClaw](https://example.com)')).toBe('[[https://example.com][NanoClaw]]');
  });
});
