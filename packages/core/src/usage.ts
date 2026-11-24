// What a call of a model used, as it is written down, and how such records are added up.
//
// One record for every call, answered or failed, written with the call's own result: a call
// that is in the conversation is in the usage, and one that is not is not.

import type {
  AccountId,
  ActorId,
  AgentId,
  Page,
  Usage,
  UsageCall,
  UsageGroup,
  UsageKind,
  UsageReport,
  UsageTotals,
} from '@acentric/protocol';

/** One call of a model. What it names is kept as it was, whatever becomes of it. */
export type UsageRecord = {
  readonly at: number;
  readonly actor: ActorId;
  /** What the call was for. A turn of its actor's, without it. */
  readonly kind?: UsageKind;
  /**
   * The actor at the top of its tree of subagents: itself, for one created from outside. The
   * store that keeps the record says which.
   */
  readonly root?: ActorId;
  readonly agent: AgentId;
  /** The version of the agent the actor was on. */
  readonly version: number;
  /** The model account the call was made with. Null when none says which. */
  readonly account: AccountId | null;
  readonly provider: string;
  readonly model: string;
  /** What the provider counted. Null for a call that failed. */
  readonly usage: Usage | null;
  /** The kind of failure, for a call that failed. */
  readonly failure: string | null;
  readonly durationMs: number;
};

/** Which calls are added up. Each filter narrows them. */
export type UsageFilter = {
  /** From this time on. */
  readonly from?: number;
  /** Up to, and not at, this time. */
  readonly to?: number;
  readonly agent?: AgentId;
  readonly actor?: ActorId;
  /** An actor created from outside, and every actor under it. */
  readonly root?: ActorId;
  readonly account?: AccountId;
  readonly provider?: string;
  readonly model?: string;
  /** The calls of turns, or those that compacted a conversation. */
  readonly kind?: UsageKind;
  /** The calls that failed, or those that were answered. */
  readonly failed?: boolean;
};

/** How usage is added up: by a group, each group by another, days and hours in a time zone. */
export type UsageGrouping = {
  readonly by?: UsageGroup;
  readonly split?: UsageGroup;
  /** An IANA time zone. UTC without it. */
  readonly tz?: string;
};

/** A page of the calls a filter leaves, newest first: `cursor` is the page before's. */
export type UsageCallsAsked = UsageFilter & { readonly limit: number; readonly cursor?: string };

const NONE: UsageTotals = {
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
};

/**
 * Of how long calls took, in milliseconds, the least that `share` of them took no longer than
 * (the nearest rank). Null of none.
 */
export function percentileOf(durations: readonly number[], share: number): number | null {
  if (durations.length === 0) return null;
  const sorted = durations.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)] ?? null;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/**
 * The day (`2026-11-22`) or the hour (`2026-11-22T13`) a time is in, in a time zone: UTC
 * without one.
 */
export function timeKey(at: number, unit: 'day' | 'hour', tz?: string): string {
  if (tz === undefined || tz === 'UTC') {
    const iso = new Date(at).toISOString();
    return unit === 'day' ? iso.slice(0, 10) : iso.slice(0, 13);
  }
  let format = formats.get(tz);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(tz, format);
  }
  const part = (type: string) =>
    format.formatToParts(at).find((each) => each.type === type)?.value ?? '00';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return unit === 'day' ? day : `${day}T${part('hour')}`;
}

/** What records add up to. */
export function totalsOf(records: readonly UsageRecord[]): UsageTotals {
  let totals = NONE;
  for (const record of records) {
    const { usage } = record;
    const cost = usage?.cost;
    totals = {
      calls: totals.calls + 1,
      failed: totals.failed + (record.failure === null ? 0 : 1),
      totalInput: totals.totalInput + (usage?.totalInput ?? 0),
      input: totals.input + (usage?.input ?? 0),
      cacheRead: totals.cacheRead + (usage?.cacheRead ?? 0),
      cacheWrite: totals.cacheWrite + (usage?.cacheWrite ?? 0),
      output: totals.output + (usage?.output ?? 0),
      reasoning: totals.reasoning + (usage?.reasoning ?? 0),
      webSearches: totals.webSearches + (usage?.webSearches ?? 0),
      cost: totals.cost + (cost?.total ?? 0),
      estimatedCost: totals.estimatedCost + (cost?.source === 'estimated' ? cost.total : 0),
      // A call that was answered and has no cost is in no total of cost.
      unpriced: totals.unpriced + (record.failure === null && cost === undefined ? 1 : 0),
      durationMs: totals.durationMs + record.durationMs,
      medianMs: null,
      p95Ms: null,
      first: totals.first === null ? record.at : Math.min(totals.first, record.at),
      last: totals.last === null ? record.at : Math.max(totals.last, record.at),
    };
  }
  const answered = records
    .filter((record) => record.failure === null)
    .map((record) => record.durationMs);
  return { ...totals, medianMs: percentileOf(answered, 0.5), p95Ms: percentileOf(answered, 0.95) };
}

/** Whether a record is one a filter leaves. */
export function passes(record: UsageRecord, filter: UsageFilter): boolean {
  return (
    (filter.from === undefined || record.at >= filter.from) &&
    (filter.to === undefined || record.at < filter.to) &&
    (filter.agent === undefined || record.agent === filter.agent) &&
    (filter.actor === undefined || record.actor === filter.actor) &&
    (filter.root === undefined || (record.root ?? record.actor) === filter.root) &&
    (filter.account === undefined || record.account === filter.account) &&
    (filter.provider === undefined || record.provider === filter.provider) &&
    (filter.model === undefined || record.model === filter.model) &&
    (filter.kind === undefined || (record.kind ?? 'turn') === filter.kind) &&
    (filter.failed === undefined || (record.failure !== null) === filter.failed)
  );
}

/** What a record is grouped under. A day or an hour is in UTC, or in `tz`. */
export function groupKey(record: UsageRecord, by: UsageGroup, tz?: string): string {
  switch (by) {
    case 'agent':
      return record.agent;
    case 'actor':
      return record.actor;
    case 'root':
      return record.root ?? record.actor;
    case 'account':
      return record.account ?? '';
    case 'provider':
      return record.provider;
    case 'model':
      return record.model;
    case 'day':
      return timeKey(record.at, 'day', tz);
    case 'hour':
      return timeKey(record.at, 'hour', tz);
    case 'failure':
      return record.failure ?? '';
    case 'kind':
      return record.kind ?? 'turn';
    case 'version':
      return String(record.version);
  }
}

/** Groups by what cost most first, and then by key. */
const byCost = (a: { key: string; totals: UsageTotals }, b: { key: string; totals: UsageTotals }) =>
  b.totals.cost - a.totals.cost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function groupsOf(
  records: readonly UsageRecord[],
  by: UsageGroup,
  tz: string | undefined,
): { key: string; of: UsageRecord[] }[] {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = groupKey(record, by, tz);
    const of = grouped.get(key);
    if (of === undefined) grouped.set(key, [record]);
    else of.push(record);
  }
  return [...grouped].map(([key, of]) => ({ key, of }));
}

/** Records added up, and by a group (and each by another) when asked: what cost most first. */
export function reportOf(
  records: readonly UsageRecord[],
  filter: UsageFilter,
  grouping: UsageGrouping = {},
): UsageReport {
  const left = records.filter((record) => passes(record, filter));
  const { by, split, tz } = grouping;
  if (by === undefined) return { totals: totalsOf(left) };
  const groups = groupsOf(left, by, tz)
    .map(({ key, of }) => ({
      key,
      totals: totalsOf(of),
      ...(split === undefined
        ? {}
        : {
            groups: groupsOf(of, split, tz)
              .map((each) => ({ key: each.key, totals: totalsOf(each.of) }))
              .toSorted(byCost),
          }),
    }))
    .toSorted(byCost);
  return { totals: totalsOf(left), groups };
}

/** A record as the API lists a call. */
export function callOf(record: UsageRecord): UsageCall {
  const { usage } = record;
  return {
    at: record.at,
    actor: record.actor,
    root: record.root ?? record.actor,
    agent: record.agent,
    version: record.version,
    account: record.account,
    provider: record.provider,
    model: record.model,
    kind: record.kind ?? 'turn',
    failure: record.failure,
    totalInput: usage?.totalInput ?? 0,
    input: usage?.input ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    output: usage?.output ?? 0,
    reasoning: usage?.reasoning ?? 0,
    webSearches: usage?.webSearches ?? 0,
    cost: usage?.cost?.total ?? null,
    costSource: usage?.cost?.source ?? null,
    durationMs: record.durationMs,
  };
}

/**
 * A page of the calls of records kept in the order they were made, newest first. A cursor is
 * the place, in that order, of the last call of the page before.
 */
export function callsOf(records: readonly UsageRecord[], asked: UsageCallsAsked): Page<UsageCall> {
  const before = asked.cursor === undefined ? records.length : Number(asked.cursor);
  const items: UsageCall[] = [];
  let at = Math.min(Number.isInteger(before) && before >= 0 ? before : 0, records.length) - 1;
  for (; at >= 0 && items.length < asked.limit; at -= 1) {
    const record = records[at];
    if (record !== undefined && passes(record, asked)) items.push(callOf(record));
  }
  // Another page when a record before the last one listed passes too.
  let more = false;
  for (let rest = at; rest >= 0; rest -= 1) {
    const record = records[rest];
    if (record !== undefined && passes(record, asked)) {
      more = true;
      break;
    }
  }
  return { items, nextCursor: more ? String(at + 1) : null };
}
