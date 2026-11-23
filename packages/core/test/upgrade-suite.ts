// Deploying an agent, and what becomes of its actors when it is deployed again: on any store.
// It is run on the store in memory here, and on the store on SQLite in its own package.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelFailure, Providers } from '@acentric/ai';
import type { ModelStep } from '@acentric/ai';
import { calls, fakeProvider, reasoned, says } from '@acentric/ai/testing';
import { makeId } from '@acentric/protocol';
import type { Json } from '@acentric/protocol';

import { Secrets } from '../src/secrets.ts';
import type { Store } from '../src/store.ts';
import { Lost } from '../src/testing.ts';
import { AGENT, CODE, MANIFEST, deferred, told, world } from './world.ts';
import type { World } from './world.ts';

const lookup = calls({ id: 'c1', name: 'lookup_order', arguments: { id: 4411 } });
const KIND = 'You are a careful support agent for a shop.';
/** The agent with other instructions: what the model is sent changes. */
const reworded = { definition: { instructions: KIND } };

/** For each answer of the model's in what a call was sent, whether its reasoning was sent. */
const reasoning = (step: ModelStep | undefined): boolean[] =>
  (step?.messages ?? [])
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.some((item) => item['type'] === 'reasoning'));

export function upgradeSuite(name: string, open: () => Promise<Store>): void {
  describe(`deploys and upgrades, on a store ${name}`, () => {
    let store: Store;
    let w: World;

    beforeEach(async () => {
      store = await open();
      w = world({ store });
    });
    afterEach(async () => {
      await store.close();
    });

    describe('a deploy', () => {
      it('makes the agent with its first deployment, which is the active one', async () => {
        const one = w.engine([]);
        const agent = await one.agent();
        expect(agent).toMatchObject({
          name: AGENT,
          provider: 'fake',
          activeDeployment: { version: 1 },
          latestDeployment: { version: 1 },
        });
        expect(await one.it.getAgent(agent.id)).toEqual(agent);
        expect(await one.it.findAgent(AGENT)).toEqual(agent);
        const deployment = await one.it.getDeployment(agent.activeDeployment.id);
        expect(deployment).toMatchObject({
          agent: agent.id,
          version: 1,
          manifest: MANIFEST,
          definition: w.definition,
          createdBy: { type: 'system' },
        });
        expect(deployment.hash).toMatch(/^[0-9a-f]{64}$/);
      });

      it('of other code is the next version of the same agent, and the active one', async () => {
        const one = w.engine([], { versions: { 'orders@2': reworded } });
        const agent = await one.agent();
        const second = await one.deploy('orders@2');
        expect(second.created).toBe(true);
        expect(second.agent).toMatchObject({
          id: agent.id,
          activeDeployment: { id: second.deployment.id, version: 2 },
          latestDeployment: { id: second.deployment.id, version: 2 },
          createdAt: agent.createdAt,
        });
        expect(second.deployment.definition.instructions).toBe(KIND);
        expect(await store.findDeployment(agent.id, 1)).toMatchObject({
          id: agent.activeDeployment.id,
        });
      });

      it('of code that is the agent’s newest already makes nothing', async () => {
        const one = w.engine([]);
        const agent = await one.agent();
        const again = await one.deploy(CODE);
        expect(again).toMatchObject({ created: false, agent, deployment: { version: 1 } });
        expect(one.executor.loads).toBe(1);
      });

      it('is kept aside when it is not to be the active one, and made active later', async () => {
        const one = w.engine([], { versions: { 'orders@2': reworded } });
        const agent = await one.agent();
        const aside = await one.deploy('orders@2', false);
        expect(aside.agent).toMatchObject({
          activeDeployment: { version: 1 },
          latestDeployment: { version: 2 },
        });
        expect((await one.it.activate(agent.id, 2)).activeDeployment).toEqual({
          id: aside.deployment.id,
          version: 2,
        });
        // The same code again, to be the active one: it is made so, and nothing else is made.
        await one.it.activate(agent.id, 1);
        const again = await one.deploy('orders@2');
        expect(again).toMatchObject({
          created: false,
          agent: { activeDeployment: { version: 2 } },
        });

        await expect(one.it.activate(agent.id, 9)).rejects.toMatchObject({ code: 'not_found' });
        const nobody = makeId('agent', { now: w.clock(), random: new Uint8Array(10).fill(9) });
        await expect(one.it.activate(nobody, 1)).rejects.toMatchObject({ code: 'not_found' });
      });

      it('at the same moment as another of its name is one after the other', async () => {
        const one = w.engine([], {
          versions: {
            'orders@2': reworded,
            'orders@3': { definition: { instructions: 'Three.' } },
          },
        });
        await one.agent();
        const [second, third] = await Promise.all([one.deploy('orders@2'), one.deploy('orders@3')]);
        expect([second.deployment.version, third.deployment.version]).toEqual([2, 3]);
        expect((await one.it.findAgent(AGENT))?.activeDeployment.version).toBe(3);
      });

      it('is refused, with nothing kept, when the code is of another provider than the agent', async () => {
        const one = w.engine([], {
          versions: { 'orders@2': { definition: { provider: 'other' } } },
          options: {
            providers: new Providers([
              fakeProvider({ run: async () => says('Hello.') }),
              { ...fakeProvider({ run: async () => says('Hello.') }), id: 'other' },
            ]),
          },
        });
        const agent = await one.agent();
        const refused = one.deploy('orders@2');
        await expect(refused).rejects.toMatchObject({ code: 'invalid_agent' });
        await expect(refused).rejects.toThrow(/does not change/);
        expect(await one.it.findAgent(AGENT)).toEqual(agent);
        expect(await store.findDeployment(agent.id, 2)).toBeUndefined();
      });

      it('is refused when the agent uses what the engine has not: a provider, or a feature', async () => {
        const versions = {
          'elsewhere@1': { definition: { provider: 'elsewhere' } },
          'machines@1': { definition: { features: ['machine', 'mcps'] } },
        };
        const one = w.engine([], { versions });
        const deploy = (on: typeof one, agent: string, code: string) =>
          on.it.deploy({ agent, manifest: MANIFEST, code });

        const provider = deploy(one, 'elsewhere', 'elsewhere@1');
        await expect(provider).rejects.toMatchObject({ code: 'unsupported_feature' });
        await expect(provider).rejects.toThrow(/elsewhere.*it has fake/);
        const features = deploy(one, 'machines', 'machines@1');
        await expect(features).rejects.toMatchObject({ code: 'unsupported_feature' });
        await expect(features).rejects.toThrow(/machine, mcps/);
        expect((await store.listAgents()).items).toEqual([]);

        // An engine that has them takes it.
        const two = w.engine([], { versions, options: { features: ['machine', 'mcps'] } });
        expect((await deploy(two, 'machines', 'machines@1')).created).toBe(true);
      });

      it('is refused for a protocol the engine does not run, and for code that does not load', async () => {
        const one = w.engine([]);
        await expect(
          one.it.deploy({ agent: AGENT, manifest: { protocol: 99, sdk: '9.0.0' }, code: CODE }),
        ).rejects.toMatchObject({ code: 'unsupported_protocol' });
        await expect(
          one.it.deploy({ agent: AGENT, manifest: MANIFEST, code: 'nothing@1' }),
        ).rejects.toMatchObject({ code: 'invalid_agent' });
        expect((await store.listAgents()).items).toEqual([]);
      });

      it('keeps what the agent asks of its provider as the provider read it, and refuses what it has not', async () => {
        const provider = {
          ...fakeProvider({ run: async () => says('Hello.') }),
          parseOptions: (given: unknown) => {
            const asked = (given ?? {}) as { webSearch?: unknown; depth?: unknown };
            if (asked.depth !== undefined) throw new TypeError('Fake has no depth');
            return asked.webSearch === undefined ? {} : { webSearch: true, read: 'by fake' };
          },
        };
        const one = w.engine([], {
          versions: {
            'orders@2': { definition: { providerOptions: { webSearch: true } } },
            'orders@3': { definition: { providerOptions: { depth: 3 } } },
          },
          options: { providers: new Providers([provider]) },
        });
        expect((await one.deploy('orders@2')).deployment.definition.providerOptions).toEqual({
          webSearch: true,
          read: 'by fake',
        });
        const refused = one.deploy('orders@3');
        await expect(refused).rejects.toMatchObject({ code: 'invalid_agent' });
        await expect(refused).rejects.toThrow('Fake has no depth');
      });

      it('says which of the secrets its code reads the agent has none of yet', async () => {
        const secrets = new Secrets({
          store,
          keys: { current: 'k1', keys: { k1: new Uint8Array(32).fill(1) } },
        });
        const named = { definition: { secrets: ['ORDERS_API_KEY', 'BILLING_KEY'] } };
        const one = w.engine([], {
          versions: {
            'orders@2': named,
            'orders@3': { definition: { ...named.definition, instructions: KIND } },
          },
          options: { secrets },
        });
        const agent = await one.agent();
        expect((await one.deploy(CODE)).missingSecrets).toEqual([]);
        expect((await one.deploy('orders@2')).missingSecrets).toEqual([
          'ORDERS_API_KEY',
          'BILLING_KEY',
        ]);
        await secrets.set(agent.id, 'ORDERS_API_KEY', 'k-1');
        expect((await one.deploy('orders@3')).missingSecrets).toEqual(['BILLING_KEY']);
      });
    });

    describe('an agent is deleted', () => {
      it('with its deployments, its secrets and its actors, and its name is free again', async () => {
        const one = w.engine([says('One.')]);
        const agent = await one.agent();
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await store.setSecret({ agent: agent.id, name: 'KEY', sealed: 's', updatedAt: 1 });

        await one.it.deleteAgent(agent.id);
        await expect(one.it.getAgent(agent.id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(one.it.getActor(actor.id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(one.say(actor.id, 'Second.')).rejects.toMatchObject({ code: 'not_found' });
        expect(await store.secretNames(agent.id)).toEqual([]);
        expect((await one.it.listActors({ limit: 10 })).items).toEqual([]);
        await expect(one.it.deleteAgent(agent.id)).rejects.toMatchObject({ code: 'not_found' });

        // Deployed again under the same name, it is a new agent, at its first version.
        const again = await one.it.deploy({ agent: AGENT, manifest: MANIFEST, code: CODE });
        expect(again).toMatchObject({ created: true, deployment: { version: 1 } });
        expect(again.agent.id).not.toBe(agent.id);
      });

      it('with the turn one of its actors is in ended first', async () => {
        const inTool = deferred<Json>();
        const called = deferred<undefined>();
        const one = w.engine([lookup], {
          lookup: () => {
            called.resolve(undefined);
            return inTool.promise;
          },
        });
        const agent = await one.agent();
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await called.promise;

        await one.it.deleteAgent(agent.id);
        await one.it.settled();
        expect(await store.loadActor(actor.id)).toBeUndefined();
        expect(await store.unfinished()).toEqual([]);
        expect(one.failures).toEqual([]);
        expect(one.it.hot).toBe(0);
      });
    });

    describe('an actor is created', () => {
      it('on its agent’s active deployment, which it follows, on the provider’s default model', async () => {
        const one = w.engine([], { versions: { 'orders@2': reworded } });
        await one.deploy('orders@2');
        const actor = await one.createActor();
        expect(actor).toMatchObject({
          deployment: { version: 2 },
          pinned: false,
          behind: null,
          modelId: 'fake-1',
          configuration: null,
        });
      });

      it('on a version it is given, and is pinned to it', async () => {
        const one = w.engine([], { versions: { 'orders@2': reworded } });
        await one.deploy('orders@2');
        const actor = await one.createActor({ version: 1 });
        expect(actor).toMatchObject({ deployment: { version: 1 }, pinned: true });
        await expect(one.createActor({ version: 9 })).rejects.toMatchObject({ code: 'not_found' });
        const nobody = makeId('agent', { now: w.clock(), random: new Uint8Array(10).fill(9) });
        await expect(one.it.createActor({ agent: nobody })).rejects.toMatchObject({
          code: 'not_found',
        });
      });

      it('with its configuration as the agent’s schema returned it, and not at all when the schema refuses it', async () => {
        const validate = (given: Json): Json => {
          const region = (given as { region?: unknown } | null)?.region;
          if (typeof region !== 'string') throw new Error('region is required');
          return { region, unit: 'hours' };
        };
        const one = w.engine([], {
          versions: {
            'orders@2': {
              definition: { configuration: { schema: null } },
              functions: { 'configuration.validate': validate },
            },
          },
        });
        const agent = await one.agent();
        await one.deploy('orders@2');

        const actor = await one.createActor({ configuration: { region: 'eu' } });
        expect(actor.configuration).toEqual({ region: 'eu', unit: 'hours' });
        // What it was given is kept too: a move to another version checks that.
        expect((await store.loadActor(actor.id))?.configurationGiven).toEqual({ region: 'eu' });

        const refused = one.createActor({ externalId: 'telegram:1' });
        await expect(refused).rejects.toMatchObject({ code: 'invalid_configuration' });
        await expect(refused).rejects.toThrow('region is required');
        expect(await store.findActor(agent.id, 'telegram:1')).toBeUndefined();
        // An agent that takes none refuses one.
        await expect(
          one.createActor({ version: 1, configuration: { region: 'eu' } }),
        ).rejects.toMatchObject({ code: 'invalid_configuration' });
      });

      it('once for an external ID: asked for again, nothing of the agent’s is run', async () => {
        const one = w.engine([], {
          versions: {
            'orders@2': {
              definition: { configuration: { schema: null } },
              functions: { 'configuration.validate': (given) => given },
            },
          },
        });
        await one.deploy('orders@2');
        const first = await one.it.createActor({
          agent: (await one.agent()).id,
          externalId: 'telegram:4411',
          configuration: { region: 'eu' },
        });
        const made = one.executor.made.length;
        const again = await one.it.createActor({
          agent: (await one.agent()).id,
          externalId: 'telegram:4411',
          configuration: 'not even looked at',
        });
        expect(first.created).toBe(true);
        expect(again).toMatchObject({ created: false, actor: { id: first.actor.id } });
        expect(one.executor.made).toHaveLength(made);
      });
    });

    describe('an actor that follows its agent', () => {
      it('moves to the active deployment as its next turn starts, not before', async () => {
        const one = w.engine([says('One.'), lookup, says('Two.')], {
          versions: {
            'orders@2': { ...reworded, functions: { 'tools.lookup_order.execute': () => 'by v2' } },
          },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);

        await one.deploy('orders@2');
        expect((await one.it.getActor(actor.id)).deployment.version).toBe(1);

        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 2 },
          behind: null,
          lastTurn: { end: 'ok' },
        });
        expect(one.steps.map((step) => step.instructions)).toEqual([
          told(w.definition.instructions),
          told(KIND),
          told(KIND),
        ]);
        // Its tool is the new version's, and the whole conversation is still there.
        const conversation = await store.conversation(actor.id);
        expect(conversation.at(-2)?.message).toMatchObject({
          role: 'tool_result',
          content: [{ type: 'text', text: 'by v2' }],
        });
        expect(conversation).toHaveLength(6);
      });

      it('ends a turn on the version the turn started on', async () => {
        const inTool = deferred<Json>();
        const called = deferred<undefined>();
        const one = w.engine([lookup, says('One.'), says('Two.')], {
          lookup: () => {
            called.resolve(undefined);
            return inTool.promise;
          },
          versions: { 'orders@2': reworded },
        });
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await called.promise;
        // Deployed while the turn waits for its tool.
        await one.deploy('orders@2');
        inTool.resolve('by v1');
        await one.it.settled(actor.id);

        expect(one.steps.map((step) => step.instructions)).toEqual([
          told(w.definition.instructions),
          told(w.definition.instructions),
        ]);
        expect((await one.it.getActor(actor.id)).deployment.version).toBe(1);

        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(one.steps.at(-1)?.instructions).toBe(told(KIND));
        expect((await one.it.getActor(actor.id)).deployment.version).toBe(2);
      });

      it('goes back when a deploy is taken back', async () => {
        const one = w.engine([says('One.'), says('Two.')], { versions: { 'orders@2': reworded } });
        await one.deploy('orders@2');
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);

        await one.it.activate((await one.agent()).id, 1);
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect((await one.it.getActor(actor.id)).deployment.version).toBe(1);
        expect(one.steps.map((step) => step.instructions)).toEqual([
          told(KIND),
          told(w.definition.instructions),
        ]);
      });

      it('stays where it is when it is pinned', async () => {
        const one = w.engine([says('One.')], { versions: { 'orders@2': reworded } });
        const actor = await one.createActor({ version: 1 });
        await one.deploy('orders@2');
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 1 },
          pinned: true,
          behind: null,
        });
        expect(one.steps[0]?.instructions).toBe(told(w.definition.instructions));
      });

      it('stays behind, and goes on working, when its configuration does not fit the new version', async () => {
        const strict = {
          definition: { instructions: KIND, configuration: { schema: null } },
          functions: {
            'configuration.validate': (given: Json): Json => {
              if (given === null) throw new Error('region is required');
              return given;
            },
          },
        };
        const one = w.engine([says('One.'), says('Two.'), says('Three.'), says('Four.')], {
          versions: {
            'orders@2': strict,
            'orders@3': { definition: { instructions: 'Three.' } },
          },
        });
        const actor = await one.createActor();
        const second = await one.deploy('orders@2');
        const behind = {
          deployment: { id: second.deployment.id, version: 2 },
          reason: 'region is required',
        };
        const checks = () =>
          one.executor.made.filter((call) => call.path === 'configuration.validate').length;

        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 1 },
          behind,
          lastTurn: { end: 'ok' },
        });
        expect(one.steps[0]?.instructions).toBe(told(w.definition.instructions));

        // The same deployment and the same configuration are not tried again at every turn.
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(checks()).toBe(1);
        expect((await one.it.getActor(actor.id)).behind).toEqual(behind);

        // Given a configuration that fits, it moves.
        const moved = await one.it.updateActor(actor.id, {
          version: 'active',
          configuration: { region: 'eu' },
        });
        expect(moved).toMatchObject({
          deployment: { version: 2 },
          configuration: { region: 'eu' },
          pinned: false,
          behind: null,
        });
        await one.say(actor.id, 'Third.');
        await one.it.settled(actor.id);
        expect(one.steps.at(-1)?.instructions).toBe(told(KIND));

        // And to a version that takes no configuration, which drops the one it has.
        await one.deploy('orders@3');
        await one.say(actor.id, 'Fourth.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 3 },
          configuration: null,
          behind: null,
        });
      });

      it('stays for a turn, and is not said to be behind, when the new version could not be asked just now', async () => {
        let asked = 0;
        const one = w.engine([says('One.'), says('Two.')], {
          versions: {
            'orders@2': {
              definition: { instructions: KIND, configuration: { schema: null } },
              functions: {
                'configuration.validate': () => {
                  asked += 1;
                  if (asked === 1) throw new Lost('workerd exited with SIGKILL');
                  return { region: 'eu' };
                },
              },
            },
          },
        });
        const actor = await one.createActor();
        await one.deploy('orders@2');
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 1 },
          behind: null,
          lastTurn: { end: 'ok' },
        });
        // It is asked again at the next turn, and moves.
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(await one.it.getActor(actor.id)).toMatchObject({
          deployment: { version: 2 },
          configuration: { region: 'eu' },
        });
      });

      it('is found on its version by an engine that starts, which loads that version’s code', async () => {
        const versions = { 'orders@2': reworded };
        const one = w.engine([says('One.'), says('Two.')], { versions });
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.deploy('orders@2');
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        await one.it.close();

        const two = w.engine([says('Three.')], { versions });
        await two.say(actor.id, 'Third.');
        await two.it.settled(actor.id);
        expect(two.steps[0]?.instructions).toBe(told(KIND));
        // Only the version the actor is on: nothing is loaded that nothing calls.
        expect(two.executor.loads).toBe(1);
        expect((await two.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
      });
    });

    describe('an actor is changed by a person', () => {
      it('in its name, its model and its reasoning, which its next call is made with', async () => {
        const one = w.engine([says('One.')]);
        const actor = await one.createActor();
        const changed = await one.it.updateActor(actor.id, {
          name: 'eu-desk',
          modelId: 'fake-bound',
          reasoning: 'high',
        });
        expect(changed).toMatchObject({
          name: 'eu-desk',
          modelId: 'fake-bound',
          reasoning: 'high',
        });
        expect((await store.loadActor(actor.id))?.actor).toEqual(changed);

        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(one.steps[0]).toMatchObject({ model: 'fake-bound', reasoning: 'high' });
        expect((await one.it.updateActor(actor.id, { name: null })).name).toBeNull();
      });

      it('in its reasoning level by a message in its conversation, where its provider has one: its calls stay as they were', async () => {
        const runner = { run: async () => says('unused') };
        const one = w.engine([says('One.'), says('Two.'), says('Three.')], {
          options: {
            providers: new Providers([fakeProvider(runner, { changesReasoningInPlace: true })]),
          },
        });
        const actor = await one.createActor({ reasoning: 'low' });
        // Before its model has answered there is nothing kept to lose: the level is just set.
        await one.it.updateActor(actor.id, { reasoning: 'medium' });
        expect(await w.roles(actor.id)).toEqual([]);
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(one.steps[0]?.reasoning).toBe('medium');

        const changed = await one.it.updateActor(actor.id, { reasoning: 'high' });
        expect(changed.reasoning).toBe('high');
        expect((await store.conversation(actor.id)).at(-1)?.message).toEqual({
          role: 'native',
          provider: 'fake',
          api: 'fake',
          content: [{ type: 'reasoning_level', level: 'high' }],
        });
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        // The call's own level is the one the conversation started with. The message says the new.
        expect(one.steps[1]?.reasoning).toBe('medium');
        expect(one.steps[1]?.messages.map((message) => message.role)).toEqual([
          'user',
          'assistant',
          'native',
          'user',
        ]);

        // Changed again, and to what it is already: one more message, and none.
        await one.it.updateActor(actor.id, { reasoning: 'max' });
        await one.it.updateActor(actor.id, { reasoning: 'max' });
        await one.say(actor.id, 'Third.');
        await one.it.settled(actor.id);
        expect(one.steps[2]?.reasoning).toBe('medium');
        expect(one.steps[2]?.messages.filter((message) => message.role === 'native')).toHaveLength(
          2,
        );
        expect(await store.loadActor(actor.id)).toMatchObject({
          reasoningSent: 'medium',
          actor: { reasoning: 'max' },
        });
      });

      it('in its reasoning level with its calls themselves, where its provider has no other way', async () => {
        const one = w.engine([says('One.'), says('Two.')]);
        const actor = await one.createActor({ reasoning: 'low' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.it.updateActor(actor.id, { reasoning: 'high' });
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(one.steps.map((step) => step.reasoning)).toEqual(['low', 'high']);
        expect(await w.roles(actor.id)).toEqual(['user', 'assistant', 'user', 'assistant']);
        expect(await store.loadActor(actor.id)).toMatchObject({ reasoningSent: null });
      });

      it('only between turns, and not while it is archived', async () => {
        const answer = deferred<ReturnType<typeof says>>();
        const asked = deferred<undefined>();
        const one = w.engine([
          () => {
            asked.resolve(undefined);
            return answer.promise;
          },
        ]);
        const actor = await one.createActor();
        await one.say(actor.id, 'First.');
        await asked.promise;
        await expect(one.it.updateActor(actor.id, { name: 'eu-desk' })).rejects.toMatchObject({
          code: 'actor_busy',
        });
        answer.resolve(says('One.'));
        await one.it.settled(actor.id);
        expect((await one.it.updateActor(actor.id, { name: 'eu-desk' })).name).toBe('eu-desk');

        await one.it.archive(actor.id);
        await expect(one.it.updateActor(actor.id, { name: 'us-desk' })).rejects.toMatchObject({
          code: 'actor_archived',
        });
      });

      it('is refused a name another actor of its agent has, and goes on as it was', async () => {
        const one = w.engine([says('One.')]);
        await one.createActor({ name: 'eu-desk' });
        const actor = await one.createActor({ name: 'us-desk' });
        await expect(one.it.updateActor(actor.id, { name: 'eu-desk' })).rejects.toMatchObject({
          code: 'name_taken',
        });
        expect((await one.it.getActor(actor.id)).name).toBe('us-desk');
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
        expect(one.failures).toEqual([]);
      });

      it('by a version, which moves it there and pins it, or has it follow again', async () => {
        const one = w.engine([says('One.'), says('Two.')], { versions: { 'orders@2': reworded } });
        await one.deploy('orders@2');
        const actor = await one.createActor();

        const pinned = await one.it.updateActor(actor.id, { version: 1 });
        expect(pinned).toMatchObject({ deployment: { version: 1 }, pinned: true });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect(one.steps[0]?.instructions).toBe(told(w.definition.instructions));

        const following = await one.it.updateActor(actor.id, { version: 'active' });
        expect(following).toMatchObject({ deployment: { version: 2 }, pinned: false });
        await expect(one.it.updateActor(actor.id, { version: 9 })).rejects.toMatchObject({
          code: 'not_found',
        });
      });

      it('in its configuration, which its version’s schema checks, with nothing changed when it fails', async () => {
        const one = w.engine([], {
          versions: {
            'orders@2': {
              definition: { configuration: { schema: null } },
              functions: {
                'configuration.validate': (given: Json): Json => {
                  if (typeof (given as { region?: unknown } | null)?.region !== 'string') {
                    throw new Error('region is required');
                  }
                  return given;
                },
              },
            },
          },
        });
        await one.deploy('orders@2');
        const actor = await one.createActor({ configuration: { region: 'eu' } });

        const refused = one.it.updateActor(actor.id, { name: 'eu-desk', configuration: {} });
        await expect(refused).rejects.toMatchObject({ code: 'invalid_configuration' });
        expect(await one.it.getActor(actor.id)).toMatchObject({
          name: null,
          configuration: { region: 'eu' },
        });
        const changed = await one.it.updateActor(actor.id, { configuration: { region: 'us' } });
        expect(changed.configuration).toEqual({ region: 'us' });
        expect((await store.loadActor(actor.id))?.configurationGiven).toEqual({ region: 'us' });
      });
    });

    describe('the model’s reasoning', () => {
      const thought = (text: string) => reasoned('Thinking it through.', says(text));
      const versions = {
        'orders@2': reworded,
        // Other code, and nothing else: the model is sent what it was sent before.
        'orders@1b': { functions: { 'tools.lookup_order.execute': () => 'by other code' } },
      };

      it('is sent back to it for as long as nothing it is sent has changed', async () => {
        const one = w.engine([thought('One.'), thought('Two.'), says('Three.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        for (const text of ['First.', 'Second.', 'Third.']) {
          await one.say(actor.id, text);
          await one.it.settled(actor.id);
        }
        expect(reasoning(one.steps[2])).toEqual([true, true]);
        expect(await store.loadActor(actor.id)).toMatchObject({ reasoningFrom: 1 });
      });

      it('from before an upgrade is not sent to a model that ties it to what came before', async () => {
        const one = w.engine([thought('One.'), thought('Two.'), says('Three.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.deploy('orders@2');
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        await one.say(actor.id, 'Third.');
        await one.it.settled(actor.id);

        // The call after the upgrade has the first answer without its reasoning.
        expect(reasoning(one.steps[1])).toEqual([false]);
        expect(one.steps[1]?.messages[1]).toMatchObject({
          role: 'assistant',
          content: [{ type: 'text', text: 'One.' }],
        });
        // What the model reasoned since is sent back as ever. What was left out stays out.
        expect(reasoning(one.steps[2])).toEqual([false, true]);
        // From the place of the first answer after the upgrade: what is before it has none.
        expect(await store.loadActor(actor.id)).toMatchObject({ reasoningFrom: 4 });
        // Nothing is taken out of the conversation itself.
        const kept = (await store.conversation(actor.id))[1]?.message;
        expect(kept).toMatchObject({ content: [{ type: 'reasoning' }, { type: 'text' }] });
      });

      it('stays left out for an engine that starts', async () => {
        const one = w.engine([thought('One.'), thought('Two.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.deploy('orders@2');
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        await one.it.close();

        const two = w.engine([says('Three.')], { versions });
        await two.say(actor.id, 'Third.');
        await two.it.settled(actor.id);
        expect(reasoning(two.steps[0])).toEqual([false, true]);
      });

      it('is kept through an upgrade for a model that does not tie it', async () => {
        const one = w.engine([thought('One.'), says('Two.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-1' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.deploy('orders@2');
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(one.steps[1]?.instructions).toBe(told(KIND));
        expect(reasoning(one.steps[1])).toEqual([true]);
        expect(await store.loadActor(actor.id)).toMatchObject({ reasoningFrom: 1 });
      });

      it('is kept through a deploy that changes the agent’s code and nothing the model is sent', async () => {
        const one = w.engine([thought('One.'), lookup, says('Two.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        expect((await one.deploy('orders@1b')).deployment.version).toBe(2);
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);

        expect((await one.it.getActor(actor.id)).deployment.version).toBe(2);
        expect(reasoning(one.steps[1])).toEqual([true]);
        expect((await store.conversation(actor.id)).at(-2)?.message).toMatchObject({
          content: [{ type: 'text', text: 'by other code' }],
        });
      });

      it('that the provider refuses is left out, and the call made again at once', async () => {
        const stale = () => {
          throw new ModelFailure(
            'The block is bound to a different conversation',
            'stale_reasoning',
          );
        };
        const one = w.engine([thought('One.'), stale, says('Two.')], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);

        expect(reasoning(one.steps[1])).toEqual([true]);
        expect(reasoning(one.steps[2])).toEqual([false]);
        expect(w.waits).toEqual([]);
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({ end: 'ok' });
        expect(await store.loadActor(actor.id)).toMatchObject({ reasoningFrom: 4 });
      });

      it('that the provider refuses though none is sent fails the turn: there is nothing left to leave out', async () => {
        const stale = () => {
          throw new ModelFailure(
            'The block is bound to a different conversation',
            'stale_reasoning',
          );
        };
        const one = w.engine([thought('One.'), stale, stale], { versions });
        const actor = await one.createActor({ modelId: 'fake-bound' });
        await one.say(actor.id, 'First.');
        await one.it.settled(actor.id);
        await one.say(actor.id, 'Second.');
        await one.it.settled(actor.id);
        expect(one.steps).toHaveLength(3);
        expect((await one.it.getActor(actor.id)).lastTurn).toMatchObject({
          end: 'failed',
          reason: 'The block is bound to a different conversation',
        });
      });
    });
  });
}
