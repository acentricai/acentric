// The MCP servers of an agent, as the engine reaches them: what they offer, how long that is
// kept, and what a server that cannot be reached comes to.

import { describe, expect, it } from 'vitest';

import type { Actor, McpServerDeclaration } from '@acentric/protocol';

import type { CallResult } from '../src/executor.ts';
import { Mcp } from '../src/mcp.ts';
import { QUIET_URL, THINGS_URL, mcpServers } from './mcp-server.ts';

const THINGS: McpServerDeclaration = { name: 'things', url: THINGS_URL };
const QUIET: McpServerDeclaration = { name: 'quiet', url: QUIET_URL };

/** As much of an actor as a server is reached for. */
const actorOf = (id: string, deployment = 'dep_1'): Actor =>
  ({ id, deployment: { id: deployment, version: 1 } }) as unknown as Actor;

function reached(headers: (path: string) => CallResult = () => ({ ok: true, value: {} })) {
  const servers = mcpServers();
  let now = 1_795_305_600_000;
  const asked: string[] = [];
  const mcp = new Mcp({
    fetch: servers.fetch,
    clock: () => now,
    call: async (_actor, path) => {
      asked.push(path);
      return path === 'mcps.things.headers' && headers(path).ok
        ? { ok: true, value: { Authorization: 'Bearer key-123' } }
        : headers(path);
    },
  });
  const lists = () => servers.methods.filter((method) => method === 'tools/list').length;
  return {
    servers,
    mcp,
    asked,
    lists,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('what an agent’s MCP servers offer', () => {
  it('is every tool of every server, each with whether it is safe to call again', async () => {
    const { mcp, asked } = reached();
    const catalog = await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(catalog.down).toEqual([]);
    expect(catalog.tools.map((tool) => [tool.server, tool.name, tool.retrySafe])).toEqual([
      ['things', 'stock', true],
      ['things', 'add_note', false],
      ['things', 'slow_note', false],
      ['things', 'slow_stock', true],
      ['things', 'broken', false],
      ['things', 'photo', false],
      ['quiet', 'whisper', false],
    ]);
    expect(catalog.tools[0]).toMatchObject({
      description: 'How many of an item are left in stock.',
      inputSchema: { type: 'object', properties: { item: { type: 'string' } } },
    });
    // The headers of each are the agent's code's to make.
    expect(asked.toSorted()).toEqual(['mcps.quiet.headers', 'mcps.things.headers']);
    expect(await mcp.catalog(actorOf('act_1'), [])).toEqual({ tools: [], down: [] });
  });

  it('is kept for an actor for ten minutes, and asked for again after', async () => {
    const { mcp, lists, advance } = reached();
    await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(lists()).toBe(2);
    advance(599_000);
    await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(lists()).toBe(2);
    // Another actor has headers of its own, and so does the same actor on other code.
    await mcp.catalog(actorOf('act_2'), [THINGS, QUIET]);
    expect(lists()).toBe(4);
    await mcp.catalog(actorOf('act_1', 'dep_2'), [THINGS, QUIET]);
    expect(lists()).toBe(6);
    advance(2000);
    await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(lists()).toBe(8);
  });

  it('is without a server that cannot be reached, which is named with why, and is asked again the next time', async () => {
    const { mcp, servers, lists } = reached();
    servers.down = true;
    const catalog = await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['whisper']);
    expect(catalog.down).toEqual([{ server: 'things', reason: expect.any(String) as string }]);
    // What was learned with a server away is not kept.
    servers.down = false;
    const again = await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(again.down).toEqual([]);
    expect(again.tools).toHaveLength(7);
    expect(lists()).toBe(3);
  });

  it('is without a server whose headers the agent’s code could not make, and says so', async () => {
    const { mcp } = reached((path) =>
      path === 'mcps.things.headers'
        ? {
            ok: false,
            kind: 'error',
            error: { name: 'Error', message: 'The secret KEY is not set' },
          }
        : { ok: true, value: {} },
    );
    const catalog = await mcp.catalog(actorOf('act_1'), [THINGS, QUIET]);
    expect(catalog.down).toEqual([
      {
        server: 'things',
        reason: 'The headers of the MCP server things could not be made: The secret KEY is not set',
      },
    ]);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(['whisper']);
  });
});

describe('a call of a tool of an MCP server', () => {
  it('answers with what the server answered, and is made with the agent’s headers', async () => {
    const { mcp, servers } = reached();
    const actor = actorOf('act_1');
    expect(await mcp.call(actor, THINGS, 'stock', { item: 'bolt' })).toMatchObject({
      content: [{ type: 'text', text: '{"item":"bolt","left":4}' }],
    });
    expect(await mcp.call(actor, THINGS, 'broken', {})).toMatchObject({
      content: [{ type: 'text', text: 'the shelf gave way' }],
      isError: true,
    });
    expect(servers.calls).toEqual(['stock:bolt', 'broken']);
    expect(servers.authorization.every((value) => value === 'Bearer key-123')).toBe(true);
  });

  it('rejects when the server cannot be reached, and when it was given up before it was made', async () => {
    const { mcp, servers } = reached();
    const actor = actorOf('act_1');
    servers.down = true;
    await expect(mcp.call(actor, THINGS, 'stock', { item: 'bolt' })).rejects.toThrow(/HTTP 503/);
    servers.down = false;
    const given = new AbortController();
    given.abort();
    await expect(mcp.call(actor, THINGS, 'stock', { item: 'bolt' }, given.signal)).rejects.toThrow(
      'This operation was aborted',
    );
    expect(servers.calls).toEqual([]);
  });
});
