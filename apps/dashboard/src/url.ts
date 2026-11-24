// What the pages read from their URLs, checked: nothing in a link decides more than it should.
//
// A check gives each of its parameters, undefined where the URL's is not good: the router lays
// what a page's check returns over the URL's own, so one that is left out would come through as
// the URL had it.

import { ID_LIST_MAX, isId } from '@acentric/protocol';

type Raw = Record<string, unknown>;

/** Where to go after signing in: a path on this site only, never another origin. */
export function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
  // Browsers drop tabs and line breaks from URLs: `/\t/evil` would become `//evil`.
  // oxlint-disable-next-line no-control-regex -- control characters are what it looks for.
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  // Whatever it is, it must resolve to this site.
  const base = 'https://dashboard.invalid';
  try {
    if (new URL(value, base).origin !== base) return undefined;
  } catch {
    return undefined;
  }
  // Not back to signing in, nor to a link's page: those are left behind once they are done.
  if (/^\/(sign-in|setup|invite|reset)(?=[/?#]|$)/.test(value)) return undefined;
  return value;
}

export type SignInSearch = { redirect?: string | undefined };

export function signInSearch(search: Raw): SignInSearch {
  return { redirect: safeRedirect(search['redirect']) };
}

export type MachinesSearch = {
  type?: string | undefined;
  agent?: string | undefined;
  actor?: string | undefined;
};

/**
 * The Machines page's filters, each a list separated by commas: of types, `personal` and the IDs
 * of sandbox accounts; and of the agents and the actors whose machines are shown. What is none of
 * them is left out.
 */
export function machinesSearch(search: Raw): MachinesSearch {
  const list = (items: readonly string[]) => (items.length === 0 ? undefined : items.join(','));
  return {
    type: list(typesOf(search['type'])),
    agent: list(idsIn(search['agent'], 'agent')),
    actor: list(idsIn(search['actor'], 'actor')),
  };
}

/** A filter of the Machines page, as its URL names it. */
export type MachinesFilter = 'type' | 'agent' | 'actor';

/** What a filter of the Machines page has chosen, from its part of the URL. */
export function chosenIn(search: MachinesSearch, filter: MachinesFilter): string[] {
  return filter === 'type' ? typesOf(search.type) : idsIn(search[filter], filter);
}

/** The IDs of one kind a list separated by commas names, once each, at most as many as a query takes. */
export function idsIn(given: unknown, kind: 'agent' | 'actor'): string[] {
  const parts = typeof given === 'string' ? given.split(',') : [];
  return [...new Set(parts.filter((part) => isId(kind, part)))].slice(0, ID_LIST_MAX);
}

/** The types a filter of the Machines page names, once each. */
export function typesOf(given: unknown): string[] {
  const parts = typeof given === 'string' ? given.split(',') : [];
  return [
    ...new Set(parts.filter((part) => part === PERSONAL || /^prv_[0-9a-z]{1,64}$/.test(part))),
  ];
}

/** What the Machines page's filter calls the machines no provider made. */
export const PERSONAL = 'personal';

export type TokenSearch = { token?: string | undefined };

/** The token of a setup, invite or reset link. Whether it is good is the server's to say. */
export function tokenSearch(search: Raw): TokenSearch {
  const token = search['token'];
  return {
    token: typeof token === 'string' && token.length > 0 && token.length <= 200 ? token : undefined,
  };
}
