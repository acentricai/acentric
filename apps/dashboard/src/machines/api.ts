// The server's calls the machine pages make, and what they ask of a failure.

import type {
  CreateSandboxRequest,
  MachineAgents,
  SandboxProviderAccount,
} from '@acentric/protocol';

import { api } from '../api.ts';

export { isApiError, isTransientRead } from '../api.ts';

/** Agents and actors whose machines are asked for: none of either is every machine. */
export type UsedBy = { readonly agents: readonly string[]; readonly actors: readonly string[] };

export const engine = {
  /** The machines, or with agents or actors, those their actors work on. */
  machines: (usedBy: UsedBy, signal?: AbortSignal) =>
    api.call('machines.list', {
      query: {
        ...(usedBy.agents.length === 0 ? {} : { agent: usedBy.agents.join(',') }),
        ...(usedBy.actors.length === 0 ? {} : { actor: usedBy.actors.join(',') }),
      },
      ...(signal === undefined ? {} : { signal }),
    }),
  addMachine: (name: string, agents: MachineAgents) =>
    api.call('machines.create', { body: { name, agents } }),
  allowAgents: (machine: string, agents: MachineAgents) =>
    api.call('machines.update', { params: { machine: machine as never }, body: { agents } }),
  machineToken: (machine: string) =>
    api.call('machines.token', { params: { machine: machine as never } }),
  /** Has the machine's daemon take this engine's build of the machine program. */
  upgradeMachine: (machine: string) =>
    api.call('machines.upgrade', { params: { machine: machine as never } }),
  removeMachine: (machine: string) =>
    api.call('machines.delete', { params: { machine: machine as never } }),
  /** The agents there are: as many as one page holds, which is more than a machine is chosen from. */
  agents: (signal?: AbortSignal) =>
    api.call('agents.list', { query: { limit: 200 }, ...(signal === undefined ? {} : { signal }) }),
  /** An agent's actors that are in a state: as many as one page holds. */
  actors: (agent: string, status: 'idle' | 'working', signal?: AbortSignal) =>
    api.call('actors.list', {
      query: { agent: agent as never, status, limit: 200 },
      ...(signal === undefined ? {} : { signal }),
    }),
  actor: (actor: string, signal?: AbortSignal) =>
    api.call('actors.get', {
      params: { actor: actor as never },
      ...(signal === undefined ? {} : { signal }),
    }),
  providers: (signal?: AbortSignal) =>
    api.call('sandboxProviders.list', signal === undefined ? {} : { signal }),
  addProvider: (kind: SandboxProviderAccount['kind'], name: string, apiKey: string) =>
    api.call('sandboxProviders.create', { body: { kind, name, apiKey } }),
  removeProvider: (provider: string) =>
    api.call('sandboxProviders.delete', { params: { provider: provider as never } }),
  sandboxes: (provider: string, signal?: AbortSignal) =>
    api.call('sandboxProviders.sandboxes', {
      params: { provider: provider as never },
      ...(signal === undefined ? {} : { signal }),
    }),
  createSandbox: (body: CreateSandboxRequest) => api.call('sandboxes.create', { body }),
  deleteSandbox: (machine: string) =>
    api.call('sandboxes.delete', { params: { machine: machine as never } }),
};

/** A value as a shell reads it whole: in single quotes, with each single quote of its own closed and opened again. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
