// The server's calls the LLM provider pages make: model accounts and usage. Usage is given as
// these pages read it, each group's totals beside its key.

import type {
  CreateAccountRequest,
  UpdateAccountRequest,
  UsageQuery,
  UsageReport,
  UsageTotals,
} from '@acentric/protocol';

import { api } from '../api.ts';

/** A group's totals beside its key, and with `split`, its own groups as `parts`. */
export type Group = { readonly key: string; readonly parts?: readonly Group[] } & UsageTotals;

/** The usage a page shows: the totals, and with `by`, each group's. */
export type UsageAnswer = { readonly total: UsageTotals; readonly groups?: readonly Group[] };

const withSignal = (signal?: AbortSignal) => (signal === undefined ? {} : { signal });

async function usageOf(report: Promise<UsageReport>): Promise<UsageAnswer> {
  const { totals, groups } = await report;
  return {
    total: totals,
    ...(groups === undefined
      ? {}
      : {
          groups: groups.map((group) => ({
            key: group.key,
            ...group.totals,
            ...(group.groups === undefined
              ? {}
              : { parts: group.groups.map((part) => ({ key: part.key, ...part.totals })) }),
          })),
        }),
  };
}

export const engine = {
  /** The accounts there are: as many as one page holds. */
  accounts: (signal?: AbortSignal) =>
    api.call('accounts.list', { query: { limit: 200 }, ...withSignal(signal) }),
  addAccount: (body: CreateAccountRequest) => api.call('accounts.create', { body }),
  updateAccount: (account: string, body: UpdateAccountRequest) =>
    api.call('accounts.update', { params: { account: account as never }, body }),
  removeAccount: (account: string) =>
    api.call('accounts.delete', { params: { account: account as never } }),
  usage: (query: UsageQuery, signal?: AbortSignal) =>
    usageOf(api.call('usage.get', { query, ...withSignal(signal) })),
  actorUsage: (actor: string, signal?: AbortSignal) =>
    usageOf(api.call('usage.actor', { params: { actor: actor as never }, ...withSignal(signal) })),
};
