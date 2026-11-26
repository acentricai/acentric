// What the agents pages keep in their URLs: a list's cursor, the actors filter, the opened
// version (`?v=12`), whether every message shows (`?all=1`), and a message (`#seq-4803`).

import type { ActorStatus } from '@acentric/protocol';

type Raw = Record<string, unknown>;

/** A value of the URL as text, or undefined when it is none. */
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : undefined;

export const STATUSES: readonly ActorStatus[] = ['working', 'idle', 'archived'];

export type ListSearch = { cursor?: string | undefined };

export function listSearch(raw: Raw): ListSearch {
  return { cursor: text(raw['cursor']) };
}

export type ActorsSearch = ListSearch & { status?: ActorStatus | undefined };

export function actorsSearch(raw: Raw): ActorsSearch {
  const status = text(raw['status']);
  return { cursor: text(raw['cursor']), status: STATUSES.find((value) => value === status) };
}

/** The opened version, and which of its tabs (`?v=2&tab=tools`); its first without one. */
export type DeploymentsSearch = { v?: number | undefined; tab?: string | undefined };

export function deploymentsSearch(raw: Raw): DeploymentsSearch {
  const v = text(raw['v']);
  const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  return { v: n, tab: n === undefined ? undefined : text(raw['tab']) };
}

export type ActorSearch = { all?: boolean | undefined };

export function actorSearch(raw: Raw): ActorSearch {
  return { all: raw['all'] === '1' || raw['all'] === 1 || raw['all'] === true ? true : undefined };
}
