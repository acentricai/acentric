// What the agents pages read, through TanStack Query. Lists are read again every ten seconds
// while the tab is in front.

import type { ActorStatus } from '@acentric/protocol';
import { useQuery, type Query, type QueryKey } from '@tanstack/react-query';

import { engine } from './api.ts';

export const LIST_REFRESH = 10_000;

/**
 * Whether two list keys are pages of one list: the same kind of thing of the same agent. Only
 * then is the previous page shown while the next loads.
 */
export function sameList(a: QueryKey, b: QueryKey): boolean {
  return a[0] === b[0] && a[1] === b[1] && a.length === b.length;
}

/** The previous page of the same list while the next loads; otherwise the loading state. */
function keepWithinList<T>(key: QueryKey) {
  return (previous: T | undefined, query: Query<T, Error, T, QueryKey> | undefined) =>
    previous !== undefined && query !== undefined && sameList(query.queryKey, key)
      ? previous
      : undefined;
}

const list = { refetchInterval: LIST_REFRESH };

export const keys = {
  /** The server's page of agents, as it is: the API keys and Machines pages keep it too. */
  agents: ['agents', 'list'] as const,
  agent: (agent: string) => ['agent', agent] as const,
  deployments: (agent: string) => ['deployments', agent] as const,
  deployment: (agent: string, deployment: string) => ['deployment', agent, deployment] as const,
  secrets: (agent: string) => ['secrets', agent] as const,
  actors: (agent: string, status: string, cursor?: string) =>
    ['actors', agent, status, cursor ?? ''] as const,
  /** The shell reads it too, for an actor's agent in the breadcrumbs. */
  actor: (actor: string) => ['actor', actor] as const,
  subagents: (actor: string) => ['subagents', actor] as const,
  inputs: (actor: string) => ['inputs', actor] as const,
  tasks: (actor: string) => ['tasks', actor] as const,
  task: (actor: string, task: string) => ['task', actor, task] as const,
  compactions: (actor: string) => ['compactions', actor] as const,
  actorUsage: (actor: string) => ['usage', 'actor', actor] as const,
};

export function useAgents() {
  return useQuery({
    queryKey: keys.agents,
    queryFn: ({ signal }) => engine.agents(signal),
    ...list,
  });
}

/** An agent, once there is one to read: an empty ID reads nothing. */
export function useAgent(agent: string) {
  return useQuery({
    queryKey: keys.agent(agent),
    queryFn: ({ signal }) => engine.agent(agent, signal),
    enabled: agent !== '',
    ...list,
  });
}

export function useDeployments(agent: string) {
  return useQuery({
    queryKey: keys.deployments(agent),
    queryFn: ({ signal }) => engine.deployments(agent, signal),
    ...list,
  });
}

/** A deployment, with what its code said of itself. A deployment never changes. */
export function useDeployment(agent: string, deployment: string | undefined) {
  return useQuery({
    queryKey: keys.deployment(agent, deployment ?? ''),
    queryFn: ({ signal }) => engine.deployment(agent, deployment ?? '', signal),
    enabled: deployment !== undefined,
    staleTime: Infinity,
  });
}

export function useSecrets(agent: string, enabled = true) {
  return useQuery({
    queryKey: keys.secrets(agent),
    queryFn: () => engine.secrets(agent),
    enabled,
    ...list,
  });
}

/** An agent's actors, newest first, or those of one status. */
export function useActors(agent: string, status: ActorStatus | undefined, cursor?: string) {
  const key = keys.actors(agent, status ?? '', cursor);
  return useQuery({
    queryKey: key,
    queryFn: () => engine.actors({ agent, ...(status === undefined ? {} : { status }) }, cursor),
    placeholderData: keepWithinList(key),
    ...list,
  });
}

export function useActor(actor: string, enabled = true) {
  return useQuery({
    queryKey: keys.actor(actor),
    queryFn: ({ signal }) => engine.actor(actor, signal),
    enabled,
    refetchInterval: LIST_REFRESH,
  });
}

export function useSubagents(actor: string) {
  return useQuery({
    queryKey: keys.subagents(actor),
    queryFn: () => engine.subagents(actor),
    ...list,
  });
}

/** What waits in an actor's mailbox. */
export function useInputs(actor: string) {
  return useQuery({ queryKey: keys.inputs(actor), queryFn: () => engine.waiting(actor), ...list });
}

export function useTasks(actor: string) {
  return useQuery({ queryKey: keys.tasks(actor), queryFn: () => engine.tasks(actor), ...list });
}

export function useTask(actor: string, task: string | null) {
  return useQuery({
    queryKey: keys.task(actor, task ?? ''),
    queryFn: () => engine.task(actor, task ?? ''),
    enabled: task !== null,
  });
}

export function useCompactions(actor: string) {
  return useQuery({
    queryKey: keys.compactions(actor),
    queryFn: () => engine.compactions(actor),
    ...list,
  });
}

/**
 * What an actor's model calls cost: its own, and with every actor under it. The second is read
 * only by a person who may read usage.
 */
export function useActorUsage(actor: string, tree: boolean) {
  return useQuery({
    queryKey: [...keys.actorUsage(actor), tree],
    queryFn: async ({ signal }) => {
      const [own, all] = await Promise.all([
        engine.actorUsage(actor, signal),
        tree ? engine.treeUsage(actor, signal) : undefined,
      ]);
      return { own: own.totals, tree: (all ?? own).totals };
    },
    refetchInterval: 15_000,
  });
}

/** Cursors seen in this tab, so `Newer` can step back one page; a shared link starts at the first. */
const previous = new Map<string, string | undefined>();

export function pageCursors(cursor: string | undefined, next: string | null | undefined) {
  return {
    older: next == null ? null : next,
    newer: cursor === undefined ? null : (previous.get(cursor) ?? ''),
    remember(nextCursor: string) {
      previous.set(nextCursor, cursor);
    },
  };
}
