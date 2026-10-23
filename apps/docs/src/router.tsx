/**
 * Routes come from the page list rather than from files: one splat route
 * resolves any path against `nav.ts` and loads that page's body. Hovering a
 * link preloads the page it points to.
 */
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
} from '@tanstack/react-router';
import { findPage } from './nav';
import { loadBody } from './content';
import { Shell } from './components/Shell';
import { DocPage } from './components/DocPage';

const rootRoute = createRootRoute({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  notFoundComponent: NotFound,
});

const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  loader: async ({ params }) => {
    // TanStack names the rest of a splat route's path `_splat`.
    // oxlint-disable-next-line no-underscore-dangle
    const page = findPage(params._splat ?? '');
    if (!page) throw notFound();
    return { page, Body: await loadBody(page) };
  },
  // A loaded page never changes while the reader is here.
  staleTime: Infinity,
  component: PageRoute,
  errorComponent: LoadFailed,
});

function PageRoute() {
  const { page, Body } = pageRoute.useLoaderData();
  return <DocPage key={page.slug} page={page} Body={Body} />;
}

function NotFound() {
  return (
    <main id="content" className="status-page">
      <p className="page-eyebrow">404</p>
      <h1>This page doesn't exist</h1>
      <p>It may have moved. Search the docs, or start from the introduction.</p>
      <Link to="/" className="button">
        Go to the introduction
      </Link>
    </main>
  );
}

function LoadFailed() {
  return (
    <main id="content" className="status-page">
      <h1>This page didn't load</h1>
      <p>
        Check your connection, then reload. If the docs were just updated, reloading fetches the new
        version.
      </p>
      <button type="button" className="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </main>
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren([pageRoute]),
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultPendingMs: 400,
});

declare module '@tanstack/react-router' {
  // Registering the router merges into TanStack's own declaration, which only an interface can.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
