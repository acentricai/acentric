// What the machine pages read. A sandbox is a machine too, so the two share one key at the top.

import { useQuery } from '@tanstack/react-query';

import { engine, isTransientRead } from './api.ts';

export const keys = {
  all: ['machines'] as const,
  machines: ['machines', 'list'] as const,
  providers: ['machines', 'providers'] as const,
  sandboxes: (providerId: string) => ['machines', 'providers', providerId, 'sandboxes'] as const,
  agents: ['agents', 'list'] as const,
};

/** Failed periodic reads grow their interval; a successful refresh resets it. */
export function readInterval(
  interval: number,
  query: { state: { error: unknown; errorUpdateCount: number } },
): number {
  return isTransientRead(query.state.error)
    ? Math.max(interval, Math.min(20_000, 100 * 2 ** query.state.errorUpdateCount))
    : interval;
}

export function useMachines(enabled = true) {
  return useQuery({
    queryKey: keys.machines,
    queryFn: ({ signal }) => engine.machines(signal),
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
    queryKey: keys.agents,
    queryFn: async ({ signal }) =>
      (await engine.agents(signal)).items.map((agent) => ({ id: agent.id, name: agent.name })),
  });
}
