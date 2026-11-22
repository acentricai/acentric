import { describe, expect, it } from 'vitest';

import { makeId } from '../src/ids.ts';
import type { IdKind } from '../src/ids.ts';
import { agentDefinitionSchema, bundleManifestSchema } from '../src/manifest.ts';
import {
  actorSchema,
  conversationEntrySchema,
  createActorRequestSchema,
  inputSchema,
  listInputsQuerySchema,
  listMessagesQuerySchema,
  sendInputRequestSchema,
  updateActorRequestSchema,
} from '../src/resources/actors.ts';
import { deployRequestSchema, deploymentSchema } from '../src/resources/agents.ts';
import {
  auditEventSchema,
  createKeyRequestSchema,
  keySchema,
  userSchema,
} from '../src/resources/people.ts';

const NOW = 1_795_305_600_000;
let made = 0;
const id = <K extends IdKind>(kind: K) => {
  made += 1;
  return makeId(kind, { now: NOW, random: new Uint8Array(10).fill(made) });
};

const definition = {
  provider: 'anthropic',
  instructions: 'You answer questions about orders.',
  configuration: { schema: { type: 'object', properties: { region: { type: 'string' } } } },
  tools: [
    {
      name: 'lookup_order',
      description: 'Finds an order.',
      parameters: { type: 'object' },
      retrySafe: true,
    },
  ],
  inputs: [{ type: 'message', schema: null }],
};

const actor = () => ({
  id: id('actor'),
  name: null,
  externalId: 'telegram:4411',
  agent: id('agent'),
  deployment: { id: id('deployment'), version: 3 },
  pinned: false,
  behind: null,
  modelId: 'claude-opus-5-5',
  reasoning: 'medium',
  configuration: { region: 'eu' },
  status: 'idle',
  lastTurn: { end: 'ok', at: NOW },
  pendingInputs: 0,
  createdAt: NOW,
  archivedAt: null,
});

describe('a deploy', () => {
  it('names the agent, and says what its code was built for', () => {
    const deploy = {
      agent: 'support',
      manifest: { protocol: 1, sdk: '0.15.0' },
      code: 'export default {}',
    };
    // It becomes the active deployment unless it says not to.
    expect(deployRequestSchema.parse(deploy)).toEqual({ ...deploy, activate: true });
    expect(deployRequestSchema.parse({ ...deploy, activate: false }).activate).toBe(false);
  });

  it('refuses an ID in place of a name, an empty code, and a field it does not know', () => {
    const deploy = {
      agent: 'support',
      manifest: { protocol: 1, sdk: '0.15.0' },
      code: 'export default {}',
    };
    expect(deployRequestSchema.safeParse({ ...deploy, agent: id('agent') }).success).toBe(false);
    expect(deployRequestSchema.safeParse({ ...deploy, code: '' }).success).toBe(false);
    expect(deployRequestSchema.safeParse({ ...deploy, id: 'my-own-id' }).success).toBe(false);
    expect(
      bundleManifestSchema.safeParse({ protocol: 1, sdk: '0.15.0', extra: true }).success,
    ).toBe(false);
  });

  it('makes a deployment that has what the code said of itself', () => {
    const deployment = {
      id: id('deployment'),
      agent: id('agent'),
      version: 1,
      hash: 'a'.repeat(64),
      manifest: { protocol: 1, sdk: '0.15.0' },
      definition,
      createdBy: { type: 'user', id: id('user') },
      createdAt: NOW,
    };
    expect(deploymentSchema.parse(deployment)).toEqual(deployment);
    expect(deploymentSchema.safeParse({ ...deployment, version: 0 }).success).toBe(false);
    expect(deploymentSchema.safeParse({ ...deployment, hash: 'abc' }).success).toBe(false);
  });

  it('takes a definition of an agent with no configuration, tools or inputs', () => {
    const bare = {
      provider: 'openai',
      instructions: '',
      configuration: null,
      tools: [],
      inputs: [],
    };
    expect(agentDefinitionSchema.parse(bare)).toEqual(bare);
  });
});

describe('an actor', () => {
  it('has an ID of its own, and a name and an external ID only when it was given them', () => {
    const one = actor();
    expect(actorSchema.parse(one)).toEqual(one);
    expect(actorSchema.parse({ ...one, name: 'eu-desk', externalId: null }).name).toBe('eu-desk');
  });

  it('is created with nothing, or with any of what it can be given', () => {
    expect(createActorRequestSchema.parse({})).toEqual({});
    const given = {
      name: 'eu-desk',
      externalId: 'telegram:4411',
      modelId: 'claude-opus-5-5',
      reasoning: 'high',
      configuration: { region: 'eu' },
    };
    expect(createActorRequestSchema.parse(given)).toEqual(given);
  });

  it('is never created with an ID from outside', () => {
    expect(createActorRequestSchema.safeParse({ id: id('actor') }).success).toBe(false);
    expect(createActorRequestSchema.safeParse({ id: 'my-actor' }).success).toBe(false);
  });

  it('can lose its name, and is moved by a version, never by a deployment ID', () => {
    expect(updateActorRequestSchema.parse({ name: null })).toEqual({ name: null });
    expect(updateActorRequestSchema.safeParse({ deployment: id('deployment') }).success).toBe(
      false,
    );
    // A number pins it to that version. `active` has it follow the active one again.
    expect(updateActorRequestSchema.parse({ version: 3 })).toEqual({ version: 3 });
    expect(updateActorRequestSchema.parse({ version: 'active' })).toEqual({ version: 'active' });
    expect(updateActorRequestSchema.safeParse({ version: 'latest' }).success).toBe(false);
    expect(updateActorRequestSchema.safeParse({ version: 0 }).success).toBe(false);
  });

  it('says when it could not move to the active deployment, and why', () => {
    const behind = {
      deployment: { id: id('deployment'), version: 4 },
      reason: 'region: Required',
    };
    expect(actorSchema.parse({ ...actor(), behind }).behind).toEqual(behind);
    expect(createActorRequestSchema.parse({ version: 2 })).toEqual({ version: 2 });
  });
});

describe('an input', () => {
  it('is sent as a type and a payload, null when it has none', () => {
    expect(sendInputRequestSchema.parse({ type: 'message', payload: { text: 'hello' } })).toEqual({
      type: 'message',
      payload: { text: 'hello' },
    });
    expect(sendInputRequestSchema.parse({ type: 'wake' })).toEqual({ type: 'wake', payload: null });
  });

  it('refuses a type that is not one, and an ID from outside', () => {
    expect(sendInputRequestSchema.safeParse({ type: 'two words' }).success).toBe(false);
    expect(sendInputRequestSchema.safeParse({ type: 'github.push' }).success).toBe(true);
    expect(sendInputRequestSchema.safeParse({ type: '~up' }).success).toBe(false);
    expect(sendInputRequestSchema.safeParse({ type: 'message', id: 'update-9' }).success).toBe(
      false,
    );
  });

  it('waits in the mailbox until a turn takes it', () => {
    const input = {
      id: id('input'),
      actor: id('actor'),
      type: 'message',
      externalId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      receivedAt: NOW,
      deliveredAt: null,
    };
    expect(inputSchema.parse(input)).toEqual(input);
  });

  it('is listed by whether it waits, which a query says as text', () => {
    expect(listInputsQuerySchema.parse({ pending: 'true' }).pending).toBe(true);
    expect(listInputsQuerySchema.parse({ pending: 'false' }).pending).toBe(false);
    expect(listInputsQuerySchema.parse({}).pending).toBeUndefined();
  });
});

describe('a conversation', () => {
  it('has entries, each with its place', () => {
    const entry = {
      seq: 2,
      message: {
        role: 'assistant',
        provider: 'anthropic',
        api: 'anthropic-messages',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Hi.' }],
      },
      createdAt: NOW,
      completion: { stopReason: 'stop', usage: { input: 12, output: 3 } },
    };
    expect(conversationEntrySchema.parse(entry)).toEqual(entry);
    expect(conversationEntrySchema.safeParse({ ...entry, seq: 0 }).success).toBe(false);
  });

  it('is read forwards by default, and from either end', () => {
    expect(listMessagesQuerySchema.parse({})).toEqual({ limit: 50, order: 'asc' });
    expect(listMessagesQuerySchema.parse({ after: '40', limit: '10' })).toEqual({
      after: 40,
      limit: 10,
      order: 'asc',
    });
    expect(listMessagesQuerySchema.parse({ order: 'desc', before: '100' })).toEqual({
      before: 100,
      limit: 50,
      order: 'desc',
    });
    expect(listMessagesQuerySchema.safeParse({ order: 'sideways' }).success).toBe(false);
  });
});

describe('people and keys', () => {
  it('a person has an email and a role', () => {
    const user = {
      id: id('user'),
      email: 'maya@example.com',
      displayName: null,
      role: 'owner',
      createdAt: NOW,
      disabledAt: null,
    };
    expect(userSchema.parse(user)).toEqual(user);
    expect(userSchema.safeParse({ ...user, role: 'root' }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, email: 'maya' }).success).toBe(false);
  });

  it("a key has a label, a scope and permissions, and is made as a person's unless it says", () => {
    const request = {
      label: 'CI deploys',
      scope: { type: 'engine' },
      permissions: ['agents:deploy'],
    };
    expect(createKeyRequestSchema.parse(request)).toEqual({ ...request, service: false });
    expect(createKeyRequestSchema.safeParse({ ...request, permissions: [] }).success).toBe(false);
    expect(createKeyRequestSchema.safeParse({ ...request, id: 'ci' }).success).toBe(false);

    const key = {
      id: id('key'),
      label: 'CI deploys',
      owner: null,
      scope: { type: 'engine' },
      permissions: ['agents:deploy'],
      expiresAt: null,
      createdBy: { type: 'system' },
      createdAt: NOW,
      lastUsedAt: null,
    };
    expect(keySchema.parse(key)).toEqual(key);
  });

  it('what was done is recorded with who did it', () => {
    const event = {
      id: id('auditEvent'),
      at: NOW,
      by: { type: 'key', id: id('key') },
      action: 'key.create',
      target: { type: 'key', id: id('key') },
      detail: null,
    };
    expect(auditEventSchema.parse(event)).toEqual(event);
    expect(auditEventSchema.safeParse({ ...event, action: 'Created a key' }).success).toBe(false);
  });
});
