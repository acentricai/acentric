// The fake server's routes of the dashboard's LLM providers area: model accounts, and usage. An
// account's key is "checked" as a provider would: one that starts `bad` is refused.

import type { Account, UsageReport, UsageTotals } from '@acentric/protocol';

import { json, refused, type Area, type Call, type Shared } from './area.ts';

const NOW = 1_795_305_600_000;

/** Totals of no calls, with what is given laid over them. */
export function totalsOf(more: Partial<UsageTotals> = {}): UsageTotals {
  return {
    calls: 0,
    failed: 0,
    totalInput: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    webSearches: 0,
    cost: 0,
    estimatedCost: 0,
    unpriced: 0,
    durationMs: 0,
    medianMs: null,
    p95Ms: null,
    first: null,
    last: null,
    ...more,
  };
}

export function llmArea(_shared: Shared) {
  const accounts: Account[] = [];
  /** What usage is answered with, for the query asked: no calls unless a test says. */
  let usage: (query: URLSearchParams) => UsageReport = (query) => ({
    totals: totalsOf(),
    ...(query.get('by') === null ? {} : { groups: [] }),
  });
  let made = 0;

  const one = (id: string | undefined) => accounts.find((account) => account.id === id);

  const answer = ({ method, path, body, query, person }: Call): Response | undefined => {
    if (method === 'GET' && path === '/v1/accounts') {
      return json(200, { items: accounts, nextCursor: null });
    }
    if (method === 'POST' && path === '/v1/accounts') {
      const provider = String(body['provider']);
      if (String(body['apiKey']).startsWith('bad')) {
        return refused(400, 'invalid_credential', `${provider} did not take the key`);
      }
      const first = !accounts.some((account) => account.provider === provider);
      const isDefault = first || body['default'] === true;
      if (isDefault) {
        for (const each of accounts) if (each.provider === provider) each.default = false;
      }
      made += 1;
      const added: Account = {
        id: `acc_${String(made).padStart(26, '0')}` as Account['id'],
        provider,
        name: String(body['name']),
        credential: 'api_key',
        default: isDefault,
        owner: null,
        agents: [],
        createdBy: { type: 'user', id: person.id as never },
        createdAt: NOW,
      };
      accounts.push(added);
      return json(201, added);
    }
    const match = /^\/v1\/accounts\/([^/]+)$/.exec(path);
    if (match !== null) {
      const found = one(match[1]);
      if (found === undefined) return refused(404, 'not_found', 'There is no such account');
      if (method === 'PATCH') {
        if (typeof body['apiKey'] === 'string' && body['apiKey'].startsWith('bad')) {
          return refused(400, 'invalid_credential', `${found.provider} did not take the key`);
        }
        if (typeof body['name'] === 'string') found.name = body['name'];
        if (body['default'] === true) {
          for (const each of accounts) {
            if (each.provider === found.provider) each.default = each === found;
          }
        }
        return json(200, found);
      }
      if (method === 'DELETE') {
        if (found.agents.length > 0) {
          return refused(
            409,
            'conflict',
            `The agents ${found.agents.join(', ')} are given this account: give them another first`,
          );
        }
        accounts.splice(accounts.indexOf(found), 1);
        const next = accounts.find((each) => each.provider === found.provider);
        if (found.default && next !== undefined) next.default = true;
        return json(204, null);
      }
    }
    if (method === 'GET' && path === '/v1/usage') return json(200, usage(query));
    return undefined;
  };

  return {
    answer,
    accounts,
    /** Answers usage with this from now on. */
    usageIs(report: (query: URLSearchParams) => UsageReport) {
      usage = report;
    },
  } satisfies Area & Record<string, unknown>;
}
