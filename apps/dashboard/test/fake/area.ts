// What one area of the fake server is given, and what it gives: its routes, and the state a test
// sets up. Each area of the dashboard keeps its routes in a file of its own here.

import type { Actor, Role } from '@acentric/protocol';

export const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const refused = (status: number, code: string, message: string, more: object = {}) =>
  json(status, { error: { code, message, ...more } });

export type Person = {
  readonly id: string;
  readonly email: string;
  password: string;
  role: Role;
  displayName?: string | null;
  photo?: string | null;
};

/** A call as an area sees it: only once someone is signed in. */
export type Call = {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly query: URLSearchParams;
  /** Who is signed in. */
  readonly person: Person;
};

/** What the fake server shares with every area. */
export type Shared = {
  readonly people: Map<string, Person>;
  readonly agents: { id: string; name: string }[];
  readonly actors: Actor[];
};

/** An area's answer to a call, or undefined when the call is not one of its routes. */
export type Area = { readonly answer: (call: Call) => Response | undefined };
