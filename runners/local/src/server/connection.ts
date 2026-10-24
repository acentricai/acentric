// One application's connection to the runner, over any transport: answers
// its requests, sends it notifications for what it subscribed to, and runs
// effects through it for the kinds it provides. When the connection ends,
// its subscriptions stop, its kinds are released, and effects it was running
// end as crashed: rerun when it, or another provider, connects, or reported
// interrupted for once effects.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isJson, PROTOCOL_VERSION, RpcError, RpcPeer } from '@acentric/protocol';
import type { ErrorCode, RpcMessage } from '@acentric/protocol';
import type { Json, JsonObject, LogQuery, Mode } from '@acentric/types';

import type { HostOutcome } from '../host/pool.js';
import { RunnerError } from '../runner.js';
import type { SessionEvent, LocalRunner, Provider, Provision } from '../runner.js';

/** Where the connection's messages go, and how to end it. */
export type Channel = { send(message: RpcMessage): void };

export type Connection = {
  /** Handles one message from the application. */
  receive(message: unknown): void;
  /** The transport ended. */
  closed(): void;
};

export const RUNNER_NAME = 'acentric-runner-local';

export function connect(runner: LocalRunner, channel: Channel): Connection {
  const subscriptions = new Map<string, () => void>();
  let provision: Provision | null = null;
  let initialized = false;
  let ended = false;

  const peer: RpcPeer = new RpcPeer((message) => channel.send(message), {
    request: async (method, params) => {
      try {
        return await answer(method, params);
      } catch (error) {
        throw toRpcError(error);
      }
    },
    // An application sends no notifications.
    notify: () => undefined,
  });

  const provider: Provider = {
    run: async (effect): Promise<HostOutcome> => {
      try {
        const result = await peer.request('effect/run', effect);
        if (isObject(result) && 'ok' in result) return { value: result['ok'] ?? null };
        if (isObject(result) && 'error' in result) return { thrown: result['error'] ?? null };
        return { invalid: true };
      } catch (error) {
        if (ended) return { crashed: true };
        return { thrown: error instanceof Error ? error.message : String(error) };
      }
    },
    cancel: (session, key) => peer.notify('effect/cancel', { session, key }),
  };

  async function answer(method: string, params: Json): Promise<Json> {
    const p = isObject(params) ? params : {};
    if (method === 'initialize') return initialize(p);
    if (!initialized) throw failure('not_initialized', 'send initialize first');
    switch (method) {
      case 'secrets/set':
        runner.setSecret(text(p, 'name'), text(p, 'value'));
        return {};
      case 'agents/deploy':
        return deploy(p);
      case 'agents/list':
        return { agents: await runner.listAgents() };
      case 'sessions/create': {
        const agent = object(p, 'agent');
        const id = optionalText(p, 'id');
        return runner.create(
          { name: text(agent, 'name'), version: text(agent, 'version') },
          object(p, 'config'),
          id === undefined ? {} : { id },
        );
      }
      case 'sessions/input': {
        const input = object(p, 'input');
        const inputId = optionalText(input, 'id');
        return runner.input(text(p, 'id'), {
          ...(inputId === undefined ? {} : { id: inputId }),
          kind: text(input, 'kind'),
          payload: object(input, 'payload'),
        });
      }
      case 'sessions/configure':
        return runner.configure(text(p, 'id'), object(p, 'config'), optionalText(p, 'requestId'));
      case 'sessions/upgrade':
        return runner.upgrade(text(p, 'id'), text(p, 'to'));
      case 'sessions/get':
        return runner.get(text(p, 'id'), { snapshot: p['snapshot'] === true });
      case 'sessions/list': {
        const agent = optionalText(p, 'agent');
        const after = optionalText(p, 'after');
        const faulted = p['faulted'];
        const limit = p['limit'];
        return {
          sessions: await runner.list({
            ...(agent === undefined ? {} : { agent }),
            ...(after === undefined ? {} : { after }),
            ...(typeof faulted === 'boolean' ? { faulted } : {}),
            ...(typeof limit === 'number' ? { limit } : {}),
          }),
        };
      }
      case 'sessions/log': {
        const page = await runner.log(text(p, 'id'), logQuery(p));
        return {
          entries: [...page.entries],
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        };
      }
      case 'sessions/journal': {
        const { after, limit, cursor } = p;
        return runner.journal(text(p, 'id'), {
          ...(typeof after === 'number' ? { after } : {}),
          ...(typeof limit === 'number' ? { limit } : {}),
          ...(typeof cursor === 'string' ? { cursor } : {}),
        });
      }
      case 'sessions/replay':
        return runner.replay(text(p, 'id'));
      case 'sessions/fork': {
        const at = p['at'];
        const as = optionalText(p, 'as');
        return runner.fork(text(p, 'id'), {
          ...(typeof at === 'number' ? { at } : {}),
          ...(as === undefined ? {} : { id: as }),
        });
      }
      case 'sessions/delete':
        await runner.delete(text(p, 'id'));
        return {};
      case 'sessions/subscribe':
        return subscribe(p);
      case 'sessions/unsubscribe': {
        const subscription = text(p, 'subscription');
        subscriptions.get(subscription)?.();
        subscriptions.delete(subscription);
        return {};
      }
      default:
        throw new RpcError(-32601, `unknown method ${method}`);
    }
  }

  function initialize(p: JsonObject): Json {
    if (initialized) throw failure('invalid_params', 'the connection is already initialized');
    if (p['protocolVersion'] !== PROTOCOL_VERSION) {
      throw failure(
        'protocol_version',
        `this runner speaks protocol ${PROTOCOL_VERSION}, not ${JSON.stringify(p['protocolVersion'] ?? null)}`,
      );
    }
    const provides = p['provides'];
    if (Array.isArray(provides) && provides.length > 0) {
      const kinds = provides.filter((kind) => typeof kind === 'string');
      provision = runner.provide(kinds, provider);
    }
    initialized = true;
    return { runner: RUNNER_NAME, protocolVersion: PROTOCOL_VERSION };
  }

  async function deploy(p: JsonObject): Promise<Json> {
    const source = async (inline: string, path: string): Promise<string> => {
      const given = optionalText(p, inline);
      if (given !== undefined) return given;
      const file = optionalText(p, path);
      if (file === undefined)
        throw failure('invalid_params', `agents/deploy needs ${inline} or ${path}`);
      return readFile(resolve(file), 'utf8');
    };
    const provides: Record<string, { mode: Mode; timeoutMs?: number; maxAttempts?: number }> = {};
    const given = p['provides'];
    if (isObject(given)) {
      for (const [kind, settings] of Object.entries(given)) {
        if (!isObject(settings))
          throw failure('invalid_params', `provides.${kind} is not an object`);
        const { mode, timeoutMs, maxAttempts } = settings;
        if (mode !== 'once' && mode !== 'reissue')
          throw failure('invalid_params', `provides.${kind} needs a mode`);
        provides[kind] = {
          mode,
          ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          ...(typeof maxAttempts === 'number' ? { maxAttempts } : {}),
        };
      }
    }
    return runner.deploy({
      name: text(p, 'name'),
      version: text(p, 'version'),
      agent: await source('agent', 'agentPath'),
      handlers: await source('handlers', 'handlersPath'),
      provides,
    });
  }

  async function subscribe(p: JsonObject): Promise<Json> {
    const id = text(p, 'id');
    const subscription = text(p, 'subscription');
    if (subscriptions.has(subscription))
      throw failure('invalid_params', `subscription ${subscription} is in use`);
    const after = p['after'];
    // Notifications can arrive before the answer: the subscription id is the client's own.
    subscriptions.set(subscription, () => undefined);
    try {
      const stop = await runner.subscribe(
        id,
        typeof after === 'number' ? { after } : {},
        (event) => {
          if (!ended) peer.notify(event.type, notification(subscription, id, event));
        },
      );
      if (subscriptions.has(subscription)) subscriptions.set(subscription, stop);
      else stop();
    } catch (error) {
      subscriptions.delete(subscription);
      throw error;
    }
    return {};
  }

  return {
    receive: (message) => {
      if (!ended) peer.receive(message);
    },
    closed: () => {
      if (ended) return;
      ended = true;
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      provision?.release();
      peer.close(new Error('the connection closed'));
    },
  };
}

function notification(subscription: string, id: string, event: SessionEvent): Json {
  switch (event.type) {
    case 'log':
      return { subscription, id, entries: event.entries };
    case 'view':
      return { subscription, id, view: event.view };
    case 'status':
      return { subscription, id, status: event.status, fault: event.fault };
  }
}

function logQuery(p: JsonObject): LogQuery {
  const { after, before, kinds, limit, cursor } = p;
  return {
    ...(typeof after === 'number' ? { after } : {}),
    ...(typeof before === 'number' ? { before } : {}),
    ...(Array.isArray(kinds) ? { kinds: kinds.filter((kind) => typeof kind === 'string') } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
  };
}

function failure(code: ErrorCode, message: string): RpcError {
  return new RpcError(code === 'invalid_params' ? -32602 : 1, message, { code });
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof RunnerError) return failure(error.code, error.message);
  return new RpcError(-32603, error instanceof Error ? error.message : String(error), {
    code: 'internal',
  });
}

function text(p: JsonObject, name: string): string {
  const value = p[name];
  if (typeof value !== 'string') throw failure('invalid_params', `${name} must be a string`);
  return value;
}

function optionalText(p: JsonObject, name: string): string | undefined {
  return p[name] === undefined ? undefined : text(p, name);
}

function object(p: JsonObject, name: string): JsonObject {
  const value = p[name];
  if (!isObject(value) || !isJson(value))
    throw failure('invalid_params', `${name} must be an object`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
