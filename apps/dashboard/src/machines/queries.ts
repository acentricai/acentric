// What the machine pages read. A sandbox is a machine too, so the two share one key at the top.

import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';

import { engine, isTransientRead } from './api.ts';
import type { UsedBy } from './api.ts';

export const keys = {
  all: ['machines'] as const,
  machines: ['machines', 'list'] as const,
  providers: ['machines', 'providers'] as const,
  sandboxes: (providerId: string) => ['machines', 'providers', providerId, 'sandboxes'] as const,
  agents: ['agents', 'list'] as const,
  activeActors: (agent: string) => ['actors', 'active', agent] as const,
  actor: (actor: string) => ['actors', actor] as const,
};

const EVERY: UsedBy = { agents: [], actors: [] };

/** Failed periodic reads grow their interval; a successful refresh resets it. */
export function readInterval(
  interval: number,
  query: { state: { error: unknown; errorUpdateCount: number } },
): number {
  return isTransientRead(query.state.error)
    ? Math.max(interval, Math.min(20_000, 100 * 2 ** query.state.errorUpdateCount))
    : interval;
}

/** The machines, or those the actors of `usedBy` work on. A change of it keeps the last list shown until the next is read. */
export function useMachines(enabled = true, usedBy: UsedBy = EVERY) {
  const filtered = usedBy.agents.length > 0 || usedBy.actors.length > 0;
  return useQuery({
    queryKey: filtered ? [...keys.machines, usedBy] : keys.machines,
    queryFn: ({ signal }) => engine.machines(usedBy, signal),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: (query) => readInterval(10_000, query),
    refetchIntervalInBackground: false,
  });
}

export function useProviders(enabled = true) {
  return useQuery({
    queryKey: keys.providers,
    queryFn: ({ signal }) => engine.providers(signal),
    enabled,
  });
}

export function useSandboxes(providerId: string) {
  return useQuery({
    queryKey: keys.sandboxes(providerId),
    queryFn: ({ signal }) => engine.sandboxes(providerId, signal),
    refetchInterval: (query) => readInterval(10_000, query),
    refetchIntervalInBackground: false,
  });
}

/** The agents there are, for choosing which may work on a machine. */
export function useAgents() {
  return useQuery({
    // The Agents and API keys pages keep the same list: the server's page of it, as it is.
    queryKey: keys.agents,
    queryFn: ({ signal }) => engine.agents(signal),
    select: (page) => page.items.map((agent) => ({ id: agent.id, name: agent.name })),
  });
}

/** An agent's actors that are not archived, newest first: those idle and those working. */
export function useActiveActors(agent: string) {
  return useQuery({
    queryKey: keys.activeActors(agent),
    queryFn: async ({ signal }) => {
      const [idle, working] = await Promise.all([
        engine.actors(agent, 'idle', signal),
        engine.actors(agent, 'working', signal),
      ]);
      return [...idle.items, ...working.items]
        .toSorted((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map((actor) => ({ id: actor.id, name: actor.name }));
    },
  });
}

/** What each actor is called: its name, or its ID while it is read or when it has none. */
export function useActorNames(actors: readonly string[]): Map<string, string> {
  const read = useQueries({
    queries: actors.map((actor) => ({
      queryKey: keys.actor(actor),
      queryFn: ({ signal }: { signal: AbortSignal }) => engine.actor(actor, signal),
      staleTime: 60_000,
    })),
  });
  return new Map(actors.map((actor, index) => [actor, read[index]?.data?.name ?? actor]));
}
