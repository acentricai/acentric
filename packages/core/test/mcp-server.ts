// MCP servers for tests, as the official library serves them: `things`, with tools that read,
// write, wait and fail, and `quiet`, with one. An engine in the test's process reaches them
// as a `fetch`.

import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

export type TestServers = {
  /** For an engine in this process. */
  readonly fetch: typeof fetch;
  /** The JSON-RPC methods asked for, in order. */
  readonly methods: string[];
  /** The `Authorization` header of each request. */
  readonly authorization: (string | null)[];
  /** Every call of a tool, in the order they arrived: `name` or `name:argument`. */
  readonly calls: string[];
  /** Set to have `things` refuse everything, as a server that is away. */
  down: boolean;
};

/** The URLs an agent of the tests names its servers by. */
export const THINGS_URL = 'https://mcp.test/things';
export const QUIET_URL = 'https://mcp.test/quiet';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function mcpServers(key = 'key-123'): TestServers {
  const methods: string[] = [];
  const authorization: (string | null)[] = [];
  const calls: string[] = [];

  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

  const things = (): McpServer => {
    const made = new McpServer({ name: 'things', version: '1.0.0' });
    made.registerTool(
      'stock',
      {
        description: 'How many of an item are left in stock.',
        inputSchema: z.object({ item: z.string().describe('The name of the item') }),
        annotations: { readOnlyHint: true },
      },
      async ({ item }) => {
        calls.push(`stock:${item}`);
        return text(JSON.stringify({ item, left: item.length }));
      },
    );
    made.registerTool(
      'add_note',
      {
        description: 'Writes a note in the warehouse book.',
        inputSchema: z.object({ text: z.string() }),
      },
      async ({ text: note }) => {
        calls.push(`add_note:${note}`);
        return text(`noted: ${note}`);
      },
    );
    made.registerTool(
      'slow_note',
      {
        description: 'Writes a note, after a while.',
        inputSchema: z.object({ text: z.string(), ms: z.number() }),
      },
      async ({ text: note, ms }) => {
        calls.push(`slow_note:${note}`);
        await sleep(ms);
        return text(`noted slowly: ${note}`);
      },
    );
    made.registerTool(
      'slow_stock',
      {
        description: 'How many of an item are left, after a while.',
        inputSchema: z.object({ item: z.string(), ms: z.number() }),
        annotations: { readOnlyHint: true },
      },
      async ({ item, ms }) => {
        calls.push(`slow_stock:${item}`);
        await sleep(ms);
        return text(JSON.stringify({ item, left: item.length }));
      },
    );
    made.registerTool('broken', { description: 'A shelf that always gives way.' }, async () => {
      calls.push('broken');
      return { ...text('the shelf gave way'), isError: true };
    });
    made.registerTool('photo', { description: 'A photo of the warehouse.' }, async () => ({
      content: [
        { type: 'text' as const, text: 'one pixel' },
        { type: 'image' as const, data: PIXEL, mimeType: 'image/png' },
      ],
    }));
    return made;
  };

  const quiet = (): McpServer => {
    const made = new McpServer({ name: 'quiet', version: '1.0.0' });
    made.registerTool(
      'whisper',
      { description: 'Says a word, very quietly.', inputSchema: z.object({ word: z.string() }) },
      async ({ word }) => {
        calls.push(`whisper:${word}`);
        return text(word.toLowerCase());
      },
    );
    return made;
  };

  const handlers: { readonly [path: string]: { fetch(request: Request): Promise<Response> } } = {
    '/things': createMcpHandler(() => things()),
    '/quiet': createMcpHandler(() => quiet()),
  };

  const state = { down: false };

  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    authorization.push(request.headers.get('authorization'));
    if (request.method === 'POST') {
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as { readonly method?: string };
      if (body.method !== undefined) methods.push(body.method);
    }
    if (pathname === '/things') {
      if (state.down) return new Response('away', { status: 503 });
      if (request.headers.get('authorization') !== `Bearer ${key}`) {
        return new Response('who are you', { status: 401 });
      }
    }
    const handler = handlers[pathname];
    if (handler === undefined) return new Response('no such server', { status: 404 });
    return handler.fetch(request);
  };

  return {
    methods,
    authorization,
    calls,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      handle(new Request(input, init))) as typeof fetch,
  };
}
