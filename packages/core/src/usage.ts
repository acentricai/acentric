// What a call of a model used, as it is written down, and how such records are added up.
//
// One record for every call, answered or failed, written with the call's own result: a call
// that is in the conversation is in the usage, and one that is not is not.

import type {
  AccountId,
  ActorId,
  AgentId,
  Usage,
  UsageGroup,
  UsageReport,
  UsageTotals,
} from '@acentric/protocol';

/** One call of a model. What it names is kept as it was, whatever becomes of it. */
export type UsageRecord = {
  readonly at: number;
  readonly actor: ActorId;
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
};

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
  first: null,
  last: null,
};

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
      first: totals.first === null ? record.at : Math.min(totals.first, record.at),
      last: totals.last === null ? record.at : Math.max(totals.last, record.at),
    };
  }
  return totals;
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
    (filter.model === undefined || record.model === filter.model)
  );
}

/** What a record is grouped under. A day is a day in UTC, as `2026-11-22`. */
export function groupKey(record: UsageRecord, by: UsageGroup): string {
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
      return new Date(record.at).toISOString().slice(0, 10);
  }
}

/** Records added up, and by a group as well when one is asked for: what cost most first. */
export function reportOf(
  records: readonly UsageRecord[],
  filter: UsageFilter,
  by?: UsageGroup,
): UsageReport {
  const left = records.filter((record) => passes(record, filter));
  if (by === undefined) return { totals: totalsOf(left) };
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of left) {
    const key = groupKey(record, by);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const groups = [...grouped]
    .map(([key, of]) => ({ key, totals: totalsOf(of) }))
    .toSorted((a, b) => b.totals.cost - a.totals.cost || (a.key < b.key ? -1 : 1));
  return { totals: totalsOf(left), groups };
}
