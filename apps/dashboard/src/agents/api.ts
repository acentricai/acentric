// The server's calls the agents pages make. Agents and actors are named by their IDs; a list is
// a page of items and the cursor of the next.

import type {
  ActorId,
  AgentId,
  CreateActorRequest,
  DeploymentId,
  SendInputRequest,
  UpdateActorRequest,
} from '@acentric/protocol';
import { fillPath, routes } from '@acentric/protocol';

import { api } from '../api.ts';

export { errorText, isApiError, queryClient } from '../api.ts';

const agentId = (id: string) => id as AgentId;
const actorId = (id: string) => id as ActorId;
const signalOf = (signal?: AbortSignal) => (signal === undefined ? {} : { signal });

/** The most a page of a list holds: what the server gives at most. */
export const PAGE = 50;

export const engine = {
  // Agents
  agents: (signal?: AbortSignal) =>
    api.call('agents.list', { query: { limit: 200 }, ...signalOf(signal) }),
  agent: (id: string, signal?: AbortSignal) =>
    api.call('agents.get', { params: { agent: agentId(id) }, ...signalOf(signal) }),
  deleteAgent: (id: string) => api.call('agents.delete', { params: { agent: agentId(id) } }),
  /** Gives an agent a model account, or its provider's default with null. */
  assignAccount: (id: string, account: string | null) =>
    api.call('agents.update', {
      params: { agent: agentId(id) },
      body: { account: account as never },
    }),
  deployments: (id: string, signal?: AbortSignal) =>
    api.call('deployments.list', {
      params: { agent: agentId(id) },
      query: { limit: 200 },
      ...signalOf(signal),
    }),
  deployment: (id: string, deployment: string, signal?: AbortSignal) =>
    api.call('deployments.get', {
      params: { agent: agentId(id), deployment: deployment as DeploymentId },
      ...signalOf(signal),
    }),
  secrets: (id: string) => api.call('secrets.list', { params: { agent: agentId(id) } }),
  setSecret: (id: string, name: string, value: string) =>
    api.call('secrets.set', { params: { agent: agentId(id), name }, body: { value } }),
  removeSecret: (id: string, name: string) =>
    api.call('secrets.delete', { params: { agent: agentId(id), name } }),

  // Actors
  actors: (
    filter: { agent?: string; status?: 'idle' | 'working' | 'archived' },
    cursor?: string,
    limit = PAGE,
  ) =>
    api.call('actors.list', {
      query: {
        ...(filter.agent === undefined ? {} : { agent: agentId(filter.agent) }),
        ...(filter.status === undefined ? {} : { status: filter.status }),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      },
    }),
  createActor: (agent: string, body: CreateActorRequest) =>
    api.call('actors.create', { params: { agent: agentId(agent) }, body }),
  actor: (id: string, signal?: AbortSignal) =>
    api.call('actors.get', { params: { actor: actorId(id) }, ...signalOf(signal) }),
  updateActor: (id: string, body: UpdateActorRequest) =>
    api.call('actors.update', { params: { actor: actorId(id) }, body }),
  send: (id: string, body: SendInputRequest) =>
    api.call('inputs.send', { params: { actor: actorId(id) }, body }),
  /** What waits in its mailbox. */
  waiting: (id: string) =>
    api.call('inputs.list', {
      params: { actor: actorId(id) },
      query: { pending: true, limit: 200 },
    }),
  interrupt: (id: string) => api.call('actors.interrupt', { params: { actor: actorId(id) } }),
  abort: (id: string) => api.call('actors.abort', { params: { actor: actorId(id) } }),
  retry: (id: string) => api.call('actors.retry', { params: { actor: actorId(id) } }),
  archive: (id: string) => api.call('actors.archive', { params: { actor: actorId(id) } }),
  unarchive: (id: string) => api.call('actors.unarchive', { params: { actor: actorId(id) } }),
  deleteActor: (id: string) => api.call('actors.delete', { params: { actor: actorId(id) } }),
  compact: (id: string) => api.call('actors.compact', { params: { actor: actorId(id) } }),
  compactions: (id: string) => api.call('actors.compactions', { params: { actor: actorId(id) } }),
  subagents: (id: string) => api.call('actors.subagents', { params: { actor: actorId(id) } }),
  tasks: (id: string) => api.call('tasks.list', { params: { actor: actorId(id) } }),
  task: (id: string, task: string) =>
    api.call('tasks.get', { params: { actor: actorId(id), task } }),
  stopTask: (id: string, task: string) =>
    api.call('tasks.stop', { params: { actor: actorId(id), task } }),
  /** Its conversation as it grows, and where it stands, from after `after`. */
  events: (id: string, after: number, signal: AbortSignal) =>
    api.events(actorId(id), { after, signal }),

  /** The model accounts an agent can be given. */
  accounts: () => api.call('accounts.list', { query: { limit: 200 } }),

  // Usage
  actorUsage: (id: string, signal?: AbortSignal) =>
    api.call('usage.actor', { params: { actor: actorId(id) }, ...signalOf(signal) }),
  /** What an actor and every actor under it used. */
  treeUsage: (id: string, signal?: AbortSignal) =>
    api.call('usage.get', { query: { root: actorId(id) }, ...signalOf(signal) }),
};

/** Where an image or file a message names as a blob is read from: this site's own API. */
export function blobUrl(actor: string, digest: string): string {
  return fillPath(routes['blobs.get'].path, { actor, digest });
}

/** One word for a POSIX shell, whatever it holds: in single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** A command that copies: never a credential of the page, always `$ENGINE_API_KEY`. */
export function curl(method: string, path: string, body?: unknown): string {
  const url = `${location.origin}${path}`;
  const parts = [`curl${method === 'GET' ? '' : ` -X ${method}`} ${shellQuote(url)}`];
  parts.push(`-H "Authorization: Bearer $ENGINE_API_KEY"`);
  if (body !== undefined) {
    parts.push(`-H 'Content-Type: application/json'`);
    parts.push(`-d ${shellQuote(JSON.stringify(body))}`);
  }
  return parts.join(' \\\n  ');
}

/**
 * The types of input an agent takes: those it declares, and a message of text, which every
 * agent takes unless it declares a `message` of its own.
 */
export function inputTypes(definition: {
  readonly inputs: readonly { readonly type: string }[];
}): string[] {
  const declared = definition.inputs.map((input) => input.type);
  return declared.includes('message') ? declared : ['message', ...declared];
}
