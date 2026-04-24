import fs from 'fs';
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PLATFORM_ID = 'emacs:default';
const CHANNEL_TYPE = 'emacs';

interface BufferedMessage {
  text: string;
  timestamp: number;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function ensureClaudeMd(): void {
  const claudeMd = path.join(GROUPS_DIR, 'emacs', 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) return;
  const content = [
    '## Message Formatting',
    '',
    'This is an Emacs channel. Responses are automatically converted from markdown',
    'to org-mode by the bridge before display.',
    '',
    '**Always format responses in standard markdown:**',
    '- `**bold**` not `*bold*`',
    '- `*italic*` not `/italic/`',
    '- `~~strikethrough~~` not `+strikethrough+`',
    '- `` `code` `` not `~code~`',
    '- ` ```lang ` fenced code blocks',
    '- `- ` for bullet points',
    '',
    'Do NOT output org-mode syntax directly. The bridge handles conversion.',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
    fs.writeFileSync(claudeMd, content, 'utf8');
    log.info('Emacs channel: wrote CLAUDE.md');
  } catch (err) {
    log.warn('Emacs channel: could not write CLAUDE.md', { err });
  }
}

export function createEmacsAdapter(): ChannelAdapter & { _server: http.Server | null } {
  let server: http.Server | null = null;
  let buffer: BufferedMessage[] = [];
  let setup: ChannelSetup | null = null;

  const envVars = readEnvFile(['EMACS_CHANNEL_PORT', 'EMACS_AUTH_TOKEN']);
  const portStr = process.env.EMACS_CHANNEL_PORT || envVars.EMACS_CHANNEL_PORT || '8766';
  const port = parseInt(portStr, 10);
  const authToken = process.env.EMACS_AUTH_TOKEN || envVars.EMACS_AUTH_TOKEN || null;

  function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!authToken) return true;
    const header = req.headers['authorization'] ?? '';
    if (header === `Bearer ${authToken}`) return true;
    res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  function handlePost(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body) as { text?: string };
        if (!text?.trim()) {
          res.writeHead(400).end(JSON.stringify({ error: 'text required' }));
          return;
        }
        const timestamp = new Date().toISOString();
        const msgId = `emacs-${Date.now()}`;
        setup?.onInbound(PLATFORM_ID, null, {
          id: msgId,
          kind: 'chat',
          timestamp,
          content: { text, sender: 'emacs', senderId: PLATFORM_ID },
        });
        res
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ messageId: msgId, timestamp: Date.now() }));
        log.info('Emacs message received', { length: text.length });
      } catch (err) {
        log.error('Emacs channel: failed to parse POST body', { err });
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  function handlePoll(url: URL, res: http.ServerResponse): void {
    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const messages = buffer.filter((m) => m.timestamp > since);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ messages }));
  }

  const adapter: ChannelAdapter & { _server: http.Server | null } = {
    name: 'emacs',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    get _server() { return server; },

    async setup(config: ChannelSetup): Promise<void> {
      setup = config;
      ensureClaudeMd();
      server = http.createServer((req, res) => {
        if (!checkAuth(req, res)) return;
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (req.method === 'POST' && url.pathname === '/api/message') {
          handlePost(req, res);
        } else if (req.method === 'GET' && url.pathname === '/api/messages') {
          handlePoll(url, res);
        } else {
          res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.listen(port, '127.0.0.1', () => {
          log.info('Emacs channel listening — load emacs/nanoclaw.el to connect', { port });
          resolve();
        });
        server!.once('error', reject);
      });
    },

    async teardown(): Promise<void> {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
        log.info('Emacs channel stopped');
      }
      setup = null;
      buffer = [];
    },

    isConnected(): boolean {
      return server?.listening ?? false;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const text = extractText(message);
      if (text === null) return undefined;
      buffer.push({ text, timestamp: Date.now() });
      if (buffer.length > 200) buffer.shift();
      return undefined;
    },
  };

  return adapter;
}

registerChannelAdapter('emacs', { factory: createEmacsAdapter });
