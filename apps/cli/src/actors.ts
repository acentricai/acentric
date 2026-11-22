// Actors: the running agents of an engine. One is made, sent what its agent takes, and its
// conversation is read, or followed as it grows.

import type { Client } from '@acentric/client';
import { REASONING_LEVELS } from '@acentric/protocol';
import type { Actor, Json, Reasoning } from '@acentric/protocol';

import { actorOf, agentOf, signedIn, withEngine } from './engine.ts';
import { machineOf } from './machines.ts';
import type { Io } from './engine.ts';
import { Fail } from './fail.ts';
import { entryLines, table, turnText } from './render.ts';

/** JSON that was given on the command line. */
function jsonOf(text: string, what: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Fail(`${what} is not JSON`);
  }
}

export async function listActors(
  io: Io,
  given: { readonly agent?: string | undefined },
): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const agent = given.agent === undefined ? undefined : await agentOf(client, given.agent);
    const actors: Actor[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.call('actors.list', {
        query: {
          limit: 200,
          ...(agent === undefined ? {} : { agent: agent.id }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      });
      actors.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    if (actors.length === 0) {
      io.out(
        agent === undefined
          ? 'The engine has no actors. Make one: `acentric actors create <agent>`.'
          : `The agent ${agent.name} has no actors. Make one: \`acentric actors create ${agent.name}\`.`,
      );
      return;
    }
    // An agent is shown by its name, which is asked for once for each.
    const names = new Map<string, string>();
    for (const actor of actors) {
      if (!names.has(actor.agent)) {
        const one = await client.call('agents.get', { params: { agent: actor.agent } });
        names.set(actor.agent, one.name);
      }
    }
    const rows = actors.map((actor) => [
      actor.id,
      names.get(actor.agent) ?? actor.agent,
      actor.name ?? '',
      actor.status,
      actor.lastTurn === null ? '' : turnText(actor.lastTurn),
    ]);
    for (const line of table(['ID', 'AGENT', 'NAME', 'STATUS', 'LAST TURN'], rows)) io.out(line);
  });
}

export async function createActor(
  io: Io,
  given: {
    readonly agent: string;
    readonly name?: string | undefined;
    readonly externalId?: string | undefined;
    readonly model?: string | undefined;
    readonly reasoning?: string | undefined;
    readonly configuration?: string | undefined;
    /** The machine it works on, by name or ID, and its working directory there. */
    readonly machine?: string | undefined;
    readonly cwd?: string | undefined;
    /** Variables its commands are run with, each as `NAME=value`. */
    readonly env?: readonly string[];
  },
): Promise<void> {
  const { reasoning } = given;
  if (given.machine === undefined && (given.cwd !== undefined || (given.env ?? []).length > 0)) {
    throw new Fail('`--cwd` and `--env` go with `--machine`, the machine the actor works on');
  }
  const env: { [name: string]: string } = {};
  for (const one of given.env ?? []) {
    const at = one.indexOf('=');
    if (at < 1) throw new Fail(`${one} is not a variable`, 'give it as `--env NAME=value`');
    env[one.slice(0, at)] = one.slice(at + 1);
  }
  if (reasoning !== undefined && !(REASONING_LEVELS as readonly string[]).includes(reasoning)) {
    throw new Fail(`${reasoning} is no reasoning level`, `one of ${REASONING_LEVELS.join(', ')}`);
  }
  const configuration =
    given.configuration === undefined
      ? undefined
      : jsonOf(given.configuration, 'the configuration');
  await withEngine(signedIn(io), async (client) => {
    const agent = await agentOf(client, given.agent);
    const machine =
      given.machine === undefined ? undefined : await machineOf(client, given.machine);
    const { actor, created } = await client.call('actors.create', {
      params: { agent: agent.id },
      body: {
        ...(machine === undefined
          ? {}
          : {
              machine: {
                id: machine.id,
                // Its user's home folder there, unless another is said.
                cwd: given.cwd ?? '~',
                ...(Object.keys(env).length === 0 ? {} : { env }),
              },
            }),
        ...(given.name === undefined ? {} : { name: given.name }),
        ...(given.externalId === undefined ? {} : { externalId: given.externalId }),
        ...(given.model === undefined ? {} : { modelId: given.model }),
        ...(reasoning === undefined ? {} : { reasoning: reasoning as Reasoning }),
        ...(configuration === undefined ? {} : { configuration }),
      },
    });
    const version = `v${String(actor.deployment.version)}`;
    io.out(
      created
        ? `Made the actor ${actor.id} of ${agent.name} ${version}, on ${actor.modelId}${
            machine === undefined || actor.machine === null
              ? ''
              : `, working on ${machine.name} in ${actor.machine.cwd}`
          }.`
        : `The actor ${actor.id} of ${agent.name} has that external ID already: nothing was made.`,
    );
    io.out(`Send it something: \`acentric actors send ${actor.id} "Hello"\`.`);
  });
}

/** The place of the last message of a conversation. 0 for one with none. */
async function lastSeq(client: Client, actor: Actor): Promise<number> {
  const { items } = await client.call('messages.list', {
    params: { actor: actor.id },
    query: { order: 'desc', limit: 1 },
  });
  return items[0]?.seq ?? 0;
}

/**
 * Prints what happens to an actor from after a place in its conversation: each message as it
 * is stored, and where the actor stands. With `untilIdle`, it is done once the actor is idle
 * with nothing waiting, and says how its turn ended. Otherwise it says where the actor stands
 * whenever that changes, until the person stops the command or the engine ends the stream.
 */
async function follow(
  io: Io,
  client: Client,
  actor: Actor,
  after: number,
  untilIdle: boolean,
): Promise<'done' | 'ended' | 'stopped'> {
  let status: string | undefined;
  for await (const event of client.events(actor.id, {
    after,
    ...(io.signal === undefined ? {} : { signal: io.signal }),
  })) {
    if (event.type === 'message') {
      for (const line of entryLines(event.entry)) io.out(line);
      continue;
    }
    const idle = event.status === 'idle' && event.pendingInputs === 0;
    const now =
      idle && event.lastTurn !== null ? `idle (${turnText(event.lastTurn)})` : event.status;
    if (untilIdle) {
      // What was sent waits, or is in a turn, until the turn that took it has ended. Only how
      // it ended is said: whether it was seen to start depends on when this began to look.
      if (!idle) continue;
      io.out(`· ${now}`);
      return 'done';
    }
    // Where it stands is said first, and then whenever it changes.
    if (now !== status) io.out(`· ${now}`);
    status = now;
  }
  return io.signal?.aborted === true ? 'stopped' : 'ended';
}

export async function sendToActor(
  io: Io,
  given: {
    readonly actor: string;
    readonly text?: string | undefined;
    readonly type: string;
    readonly payload?: string | undefined;
    readonly follow: boolean;
  },
): Promise<void> {
  if ((given.text === undefined) === (given.payload === undefined)) {
    throw new Fail('say what to send: the text of a message, or `--payload <json>`');
  }
  const payload: Json =
    given.payload === undefined ? { text: given.text ?? '' } : jsonOf(given.payload, 'the payload');
  await withEngine(signedIn(io), async (client) => {
    const actor = await actorOf(client, given.actor);
    const before = given.follow ? await lastSeq(client, actor) : 0;
    await client.call('inputs.send', {
      params: { actor: actor.id },
      body: { type: given.type, payload },
    });
    if (!given.follow) {
      io.out(`Sent to ${actor.id}. Read what it does with \`acentric actors logs ${actor.id}\`.`);
      return;
    }
    const how = await follow(io, client, actor, before, true);
    if (how === 'ended') {
      throw new Fail(
        'the engine stopped answering before the turn ended',
        `go on from where it is with \`acentric actors logs ${actor.id} --follow\``,
      );
    }
    const { lastTurn } = await client.call('actors.get', { params: { actor: actor.id } });
    if (how === 'done' && lastTurn !== null && lastTurn.end !== 'ok') {
      throw new Fail(`the turn ended ${turnText(lastTurn)}`);
    }
  });
}

export async function actorLogs(
  io: Io,
  given: { readonly actor: string; readonly follow: boolean },
): Promise<void> {
  await withEngine(signedIn(io), async (client) => {
    const actor = await actorOf(client, given.actor);
    let seen = 0;
    for (;;) {
      const page = await client.call('messages.list', {
        params: { actor: actor.id },
        query: { after: seen, limit: 200 },
      });
      for (const entry of page.items) {
        for (const line of entryLines(entry)) io.out(line);
        seen = entry.seq;
      }
      if (page.nextCursor === null) break;
    }
    if (!given.follow) {
      const now = await client.call('actors.get', { params: { actor: actor.id } });
      io.out(
        `· ${now.status}${now.lastTurn === null ? '' : `, its last turn ${turnText(now.lastTurn)}`}${
          now.pendingInputs === 0 ? '' : `, ${String(now.pendingInputs)} waiting`
        }`,
      );
      return;
    }
    const how = await follow(io, client, actor, seen, false);
    if (how === 'ended') throw new Fail('the engine ended the stream', 'run it again to go on');
  });
}
