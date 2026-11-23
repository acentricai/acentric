// The dashboard's pages. Those of signing in and of links are open to anyone; every other page
// is for a person signed in, and sends anyone else to sign in, and back after.

import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';

import { isApiError, meQuery, queryClient } from './api.ts';
import { FailedPage } from './pages/failed.tsx';
import { HomePage } from './pages/home.tsx';
import { InvitePage } from './pages/invite.tsx';
import { NotFoundPage } from './pages/not-found.tsx';
import { ResetPage } from './pages/reset.tsx';
import { SetupPage } from './pages/setup.tsx';
import { SignInPage } from './pages/sign-in.tsx';
import { signInSearch, tokenSearch } from './url.ts';

/** Who is signed in, as the server says: undefined for no one. Rejects when it cannot say. */
async function signedIn() {
  try {
    return await queryClient.ensureQueryData(meQuery);
  } catch (error) {
    if (isApiError(error, 401)) return undefined;
    throw error;
  }
}

const root = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage,
  errorComponent: FailedPage,
});

const signIn = createRoute({
  getParentRoute: () => root,
  path: 'sign-in',
  validateSearch: signInSearch,
  // Someone signed in already goes where they were going.
  beforeLoad: async ({ search }) => {
    const me = await signedIn().catch(() => undefined);
    if (me !== undefined) throw redirect({ href: search.redirect ?? '/', replace: true });
  },
  component: SignInPage,
});

const setup = createRoute({
  getParentRoute: () => root,
  path: 'setup',
  validateSearch: tokenSearch,
  component: SetupPage,
});

const invite = createRoute({
  getParentRoute: () => root,
  path: 'invite',
  validateSearch: tokenSearch,
  component: InvitePage,
});

const reset = createRoute({
  getParentRoute: () => root,
  path: 'reset',
  validateSearch: tokenSearch,
  component: ResetPage,
});

/** Every page of a person signed in. */
const people = createRoute({
  getParentRoute: () => root,
  id: 'signed-in',
  beforeLoad: async ({ location }) => {
    const me = await signedIn();
    if (me === undefined || me.type !== 'user') {
      throw redirect({ to: '/sign-in', search: signInSearch({ redirect: location.href }) });
    }
  },
  component: Outlet,
});

const home = createRoute({
  getParentRoute: () => people,
  path: '/',
  component: HomePage,
});

const tree = root.addChildren([signIn, setup, invite, reset, people.addChildren([home])]);

/** The dashboard's router: on the browser's history, or on another, for tests. */
export function makeRouter(history?: RouterHistory) {
  return createRouter({
    routeTree: tree,
    defaultPreload: false,
    ...(history === undefined ? {} : { history }),
  });
}

export type Router = ReturnType<typeof makeRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: Router;
  }
}

/** The server no longer knows who was signed in: forget them, and sign in again from here. */
export function signedOut(router: Router): void {
  const { href } = router.state.location;
  queryClient.clear();
  void router.navigate({
    to: '/sign-in',
    search: signInSearch({ redirect: href }),
    replace: true,
  });
}

/** Another tab signed in or out: what was read here as whoever was signed in is read again. */
export function changedElsewhere(router: Router): void {
  queryClient.clear();
  void router.invalidate();
}
