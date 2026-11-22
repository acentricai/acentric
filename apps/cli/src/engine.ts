// The engine, as the command calls it: with the client every program calls it with, and with
// what went wrong said as a command says it.

import { ApiError, createClient } from '@acentric/client';
import type { Client } from '@acentric/client';
import { parseId } from '@acentric/protocol';
import type { Actor, ActorId, Agent, Principal } from '@acentric/protocol';

import type { Credentials, Env } from './credentials.ts';
import { readCredentials } from './credentials.ts';
import { Fail } from './fail.ts';
import { noting } from './update.ts';

/** What a command is given of the world: where it runs, what it may read, and where it writes. */
export type Io = {
  readonly cwd: string;
  readonly env: Env;
  readonly out: (line: string) => void;
  /** Asks for a secret, not shown as it is typed. */
  readonly secret: (prompt: string) => Promise<string>;
  /** Aborted when the person stops the command. */
  readonly signal?: AbortSignal;
};

export function signedIn(io: Io): Credentials {
  const credentials = readCredentials(io.env);
  if (credentials === undefined) {
    throw new Fail('not signed in to an engine', 'run `acentric login <engine address>`');
  }
  return credentials;
}

/** What went wrong with a call, as a command says it. Anything else is given back as it is. */
function failOf(engine: string, error: unknown): unknown {
  if (error instanceof ApiError) {
    if (error.code === 'unknown') {
      return new Fail(
        `${engine} answered ${String(error.status)}, and not as an engine does`,
        'is it the engine’s address?',
      );
    }
    const issues = (error.issues ?? []).map((issue) => {
      const at = (issue.path ?? []).join('.');
      return `\n  ${at === '' ? '' : `${at}: `}${issue.message}`;
    });
    const message = `${error.message}${issues.join('')}`;
    if (error.status === 401) return new Fail(message, 'sign in again: `acentric login`');
    return new Fail(message);
  }
  if (error instanceof SyntaxError) {
    return new Fail(`${engine} did not answer as an engine does`, 'is it the engine’s address?');
  }
  if (error instanceof TypeError) {
    const cause = (error.cause as Error | undefined)?.message;
    return new Fail(`the engine at ${engine} could not be reached: ${cause ?? error.message}`);
  }
  return error;
}

/** Does something with the engine. What the engine refuses, or cannot be asked, is a `Fail`. */
export async function withEngine<T>(
  credentials: Credentials,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  try {
    const { engine, key } = credentials;
    // What the engine says it hands out is kept, for offering its version of the command.
    return await work(createClient({ baseUrl: engine, token: key, fetch: noting(engine) }));
  } catch (error) {
    throw failOf(credentials.engine, error);
  }
}

/** What a key reaches, or who a person is, in a few words. */
export function reachOf(me: Principal): string {
  if (me.type === 'user') return 'the whole engine';
  if (me.scope.type === 'engine') return 'the whole engine';
  if (me.scope.type === 'agent') return `the agent ${me.scope.agent}`;
  return `the actor ${me.scope.actor}`;
}

/** Who a request is from, as a person reads it. */
export function whoOf(me: Principal): string {
  return me.type === 'user' ? `as ${me.email}, ${me.role}` : `with the key ${me.key}`;
}

/** The agent of a name, or of an ID. */
export async function agentOf(client: Client, given: string): Promise<Agent> {
  if (parseId(given)?.kind === 'agent') {
    return client.call('agents.get', { params: { agent: given as Agent['id'] } });
  }
  const [agent] = (await client.call('agents.list', { query: { name: given } })).items;
  if (agent === undefined) {
    throw new Fail(`the engine has no agent ${given}`, 'deploy it with `acentric deploy`');
  }
  return agent;
}

/** The actor of an ID, or of `<agent>/<name>`. */
export async function actorOf(client: Client, given: string): Promise<Actor> {
  if (parseId(given)?.kind === 'actor') {
    return client.call('actors.get', { params: { actor: given as ActorId } });
  }
  const [agentName, name, ...more] = given.split('/');
  if (agentName === undefined || name === undefined || name === '' || more.length > 0) {
    throw new Fail(
      `${given} names no actor`,
      'give its ID, such as act_…, or <agent>/<name> for one that has a name',
    );
  }
  const agent = await agentOf(client, agentName);
  const [actor] = (await client.call('actors.list', { query: { agent: agent.id, name } })).items;
  if (actor === undefined) throw new Fail(`the agent ${agent.name} has no actor named ${name}`);
  return actor;
}
