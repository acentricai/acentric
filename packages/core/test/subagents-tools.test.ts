// The tools of subagents alone, with a host that stands in for the engine.

import { describe, expect, it } from 'vitest';

import type { Actor, AgentDefinition } from '@acentric/protocol';

import { ActorNotFound } from '../src/errors.ts';
import { subagentTools } from '../src/subagents.ts';
import type { SubagentsHost } from '../src/subagents.ts';

describe('message_agent to a parent that is gone', () => {
  it('is answered that it is gone, and fails nothing else', async () => {
    const host = {
      post: async (to: string) => {
        throw new ActorNotFound(to as never);
      },
    } as unknown as SubagentsHost;
    const tool = subagentTools(host).find((one) => one.tool.name === 'message_agent');
    const actor = {
      id: 'act_child',
      parent: { id: 'act_parent', name: 'rev', call: 'c1' },
    } as unknown as Actor;
    const told = await tool?.run(
      actor,
      {} as AgentDefinition,
      { to: 'parent', message: 'Done.' },
      { id: 'c2' },
    );
    expect(told).toEqual({
      content: 'Your parent is gone: it was deleted, and takes nothing',
      isError: true,
    });
  });
});
