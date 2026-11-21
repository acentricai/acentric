import { describe, expect, it } from 'vitest';

import { builtInProviders } from '@acentric/ai';
import type { Credential } from '@acentric/ai';
import type { Actor, AgentDefinition } from '@acentric/protocol';

import { providerRunners } from '../src/runners.ts';

const actor = {} as Actor;
const of = (provider: string): AgentDefinition => ({
  provider,
  instructions: '',
  configuration: null,
  tools: [],
  inputs: [],
});

describe('providerRunners', () => {
  it('gives an agent the runner of its provider, made once', () => {
    const asked: string[] = [];
    const source = providerRunners(builtInProviders(), (provider): Credential => {
      asked.push(provider);
      return { type: 'api_key', apiKey: 'a-key' };
    });
    const first = source(actor, of('anthropic'));
    expect(source(actor, of('anthropic'))).toBe(first);
    expect(source(actor, of('openai'))).not.toBe(first);
    expect(asked).toEqual(['anthropic', 'openai']);
  });

  it('has none for a provider the engine has not, or one with no credential', () => {
    const source = providerRunners(builtInProviders(), () => undefined);
    expect(() => source(actor, of('claude'))).toThrow(/There is no provider claude/);
    expect(() => source(actor, of('fireworks'))).toThrow(/There is no account for Fireworks/);
  });
});
