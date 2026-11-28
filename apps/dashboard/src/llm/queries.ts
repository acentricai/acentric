// What the LLM provider pages read. Usage is read again every half minute while the tab is in
// front: model calls go on being made.

import type { UsageQuery } from '@acentric/protocol';
import { useQuery } from '@tanstack/react-query';

import { engine } from './api.ts';

export const keys = {
  all: ['llm'] as const,
  accounts: ['llm', 'accounts'] as const,
  providers: ['llm', 'providers'] as const,
  usage: (query: UsageQuery) => ['llm', 'usage', query] as const,
  actorUsage: (actor: string) => ['llm', 'actor-usage', actor] as const,
};

/** The model accounts. */
export function useAccounts(enabled = true) {
  return useQuery({
    queryKey: keys.accounts,
    queryFn: async ({ signal }) => (await engine.accounts(signal)).items,
    enabled,
  });
}

/** The providers of models the server has. */
export function useModelProviders() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: async ({ signal }) => (await engine.modelProviders(signal)).data,
    staleTime: Infinity,
  });
}

export function useUsage(query: UsageQuery, enabled = true) {
  return useQuery({
    queryKey: keys.usage(query),
    queryFn: ({ signal }) => engine.usage(query, signal),
    enabled,
    refetchInterval: 30_000,
    // The previous answer stays while another range or grouping is read.
    placeholderData: (previous) => previous,
  });
}

export function useActorUsage(actor: string) {
  return useQuery({
    queryKey: keys.actorUsage(actor),
    queryFn: ({ signal }) => engine.actorUsage(actor, signal),
    refetchInterval: 15_000,
  });
}
