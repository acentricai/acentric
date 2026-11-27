// The fake server's routes of the dashboard's LLM providers area: model accounts, and usage. An
// account's key is "checked" as a provider would: one that starts `bad` is refused.

import { NAME_PATTERN } from '@acentric/protocol';
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

/** A call of a model the fake server adds up, as the server would. */
export type FakeCall = {
  readonly at: number;
  readonly agent: string;
  readonly actor: string;
  readonly provider: string;
  readonly model: string;
  readonly cost: number;
  readonly input?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly failed?: boolean;
  readonly durationMs?: number;
};

/** The day of a time, in a time zone, as the server names one. */
const dayIn = (at: number, tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

const middle = (sorted: readonly number[], share: number) =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? null);

function callTotals(calls: readonly FakeCall[]): UsageTotals {
  const answered = calls
    .filter((call) => call.failed !== true)
    .map((call) => call.durationMs ?? 1000)
    .toSorted((a, b) => a - b);
  const sum = (of: (call: FakeCall) => number) => calls.reduce((all, call) => all + of(call), 0);
  return totalsOf({
    calls: calls.length,
    failed: calls.filter((call) => call.failed === true).length,
    input: sum((call) => call.input ?? 0),
    cacheRead: sum((call) => call.cacheRead ?? 0),
    cacheWrite: sum((call) => call.cacheWrite ?? 0),
    totalInput: sum((call) => (call.input ?? 0) + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0)),
    output: sum((call) => call.output ?? 0),
    reasoning: sum((call) => call.reasoning ?? 0),
    cost: sum((call) => call.cost),
    durationMs: sum((call) => call.durationMs ?? 1000),
    medianMs: middle(answered, 0.5),
    p95Ms: middle(answered, 0.95),
    first: calls.length === 0 ? null : Math.min(...calls.map((call) => call.at)),
    last: calls.length === 0 ? null : Math.max(...calls.map((call) => call.at)),
  });
}

/** What calls add up to for a query of usage: its filters, `by`, `split` and `tz`. */
export function reportOfCalls(calls: readonly FakeCall[], query: URLSearchParams): UsageReport {
  const from = Number(query.get('from') ?? 0);
  const to = query.get('to') === null ? Infinity : Number(query.get('to'));
  const left = calls.filter(
    (call) =>
      call.at >= from &&
      call.at < to &&
      (query.get('agent') === null || call.agent === query.get('agent')) &&
      (query.get('provider') === null || call.provider === query.get('provider')) &&
      (query.get('model') === null || call.model === query.get('model')),
  );
  const tz = query.get('tz') ?? 'UTC';
  const keyOf = (call: FakeCall, by: string) =>
    by === 'day'
      ? dayIn(call.at, tz)
      : by === 'root' || by === 'actor'
        ? call.actor
        : String(call[by as 'agent' | 'provider' | 'model']);
  const grouped = (of: readonly FakeCall[], by: string) => {
    const groups = new Map<string, FakeCall[]>();
    for (const call of of)
      groups.set(keyOf(call, by), [...(groups.get(keyOf(call, by)) ?? []), call]);
    return [...groups]
      .map(([key, them]) => ({ key, them, totals: callTotals(them) }))
      .toSorted((a, b) => b.totals.cost - a.totals.cost || (a.key < b.key ? -1 : 1));
  };
  const by = query.get('by');
  const split = query.get('split');
  if (by === null) return { totals: callTotals(left) };
  return {
    totals: callTotals(left),
    groups: grouped(left, by).map(({ key, them, totals }) => ({
      key,
      totals,
      ...(split === null
        ? {}
        : { groups: grouped(them, split).map((part) => ({ key: part.key, totals: part.totals })) }),
    })),
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
  /** The ChatGPT sign-ins that wait, by ID: what each is for, and the state its address carries. */
  const signIns = new Map<string, { name?: string; account?: string; state: string }>();
  /** What was asked of them, in order. */
  const signInCalls: { method: string; path: string; body: unknown }[] = [];

  const one = (id: string | undefined) => accounts.find((account) => account.id === id);

  const answer = ({ method, path, body, query, person }: Call): Response | undefined => {
    if (method === 'GET' && path === '/v1/accounts') {
      return json(200, { items: accounts, nextCursor: null });
    }
    if (method === 'POST' && path === '/v1/accounts') {
      const provider = String(body['provider']);
      if (!NAME_PATTERN.test(String(body['name']))) {
        return refused(400, 'invalid_request', 'The body is not what this takes', {
          issues: [
            {
              message:
                'A name is lowercase letters, digits, - and _, starting with a letter or digit, 63 at most',
              path: ['name'],
            },
          ],
        });
      }
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
        actors: 0,
        createdBy: { type: 'user', id: person.id as never },
        createdAt: NOW,
      };
      accounts.push(added);
      return json(201, added);
    }
    if (path.startsWith('/v1/chatgpt-sign-ins')) {
      signInCalls.push({ method, path, body });
      if (method === 'POST' && path === '/v1/chatgpt-sign-ins') {
        if (typeof body['name'] === 'string' && accounts.some((a) => a.name === body['name'])) {
          return refused(409, 'name_taken', `An account is named ${body['name']} already`);
        }
        const id = `sgn_${String(signIns.size + 1).padStart(26, '0')}`;
        const state = `state-${String(signIns.size + 1)}`;
        signIns.set(id, {
          state,
          ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
          ...(typeof body['account'] === 'string' ? { account: body['account'] } : {}),
        });
        return json(201, {
          id,
          url: `https://auth.openai.com/api/accounts/authorize?state=${state}`,
          expiresAt: NOW + 600_000,
          ...(typeof body['account'] === 'string' ? { account: body['account'] } : {}),
        });
      }
      const signIn = /^\/v1\/chatgpt-sign-ins\/([^/]+)(\/callback)?$/.exec(path);
      const waiting = signIn === null ? undefined : signIns.get(signIn[1] ?? '');
      if (signIn === null || waiting === undefined) {
        return refused(404, 'not_found', 'There is no sign-in waiting: start another');
      }
      const shown = () => ({
        id: signIn[1],
        url: `https://auth.openai.com/api/accounts/authorize?state=${waiting.state}`,
        expiresAt: NOW + 600_000,
        ...(waiting.account === undefined ? {} : { account: waiting.account }),
      });
      if (method === 'GET') return json(200, shown());
      if (method === 'DELETE') {
        signIns.delete(signIn[1] ?? '');
        return json(204, null);
      }
      // OpenAI refused its code: it waits again, on a new page.
      if (String(body['url']).includes('refused')) {
        waiting.state = `${waiting.state}-again`;
        return refused(400, 'invalid_request', 'ChatGPT did not take that sign-in’s code');
      }
      if (!String(body['url']).includes(`state=${waiting.state}`)) {
        return refused(400, 'invalid_request', 'That is not the address of this sign-in');
      }
      signIns.delete(signIn[1] ?? '');
      const again = one(waiting.account);
      if (again !== undefined) {
        again.signIn = { email: 'ada@example.test' };
        return json(200, again);
      }
      made += 1;
      const added: Account = {
        id: `acc_${String(made).padStart(26, '0')}` as Account['id'],
        provider: 'chatgpt',
        name: waiting.name ?? '',
        credential: 'access_token',
        signIn: { email: 'ada@example.test' },
        default: !accounts.some((account) => account.provider === 'chatgpt'),
        owner: null,
        actors: 0,
        createdBy: { type: 'user', id: person.id as never },
        createdAt: NOW,
      };
      accounts.push(added);
      return json(200, added);
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
        if (found.actors > 0) {
          return refused(
            409,
            'conflict',
            `${String(found.actors)} actors are given this account: archive or delete them first`,
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
    signInCalls,
    /** Answers usage with this from now on. */
    usageIs(report: (query: URLSearchParams) => UsageReport) {
      usage = report;
    },
    /** Answers usage by adding these calls up, as the server would. */
    callsAre(calls: readonly FakeCall[]) {
      usage = (query) => reportOfCalls(calls, query);
    },
  } satisfies Area & Record<string, unknown>;
}
