// What the pages read from their URLs, checked: nothing in a link decides more than it should.
//
// A check gives each of its parameters, undefined where the URL's is not good: the router lays
// what a page's check returns over the URL's own, so one that is left out would come through as
// the URL had it.

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

export type TokenSearch = { token?: string | undefined };

/** The token of a setup, invite or reset link. Whether it is good is the server's to say. */
export function tokenSearch(search: Raw): TokenSearch {
  const token = search['token'];
  return {
    token: typeof token === 'string' && token.length > 0 && token.length <= 200 ? token : undefined,
  };
}
