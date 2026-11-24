// The dashboard, served beside the API: the files its build made, from one folder. A path that
// names no file is answered with its page, `index.html`, so that every address of the dashboard
// opens it: `/setup?token=…` and `/reset?token=…`, which the server's own links point to, among
// them. The page may call only this server, may not be framed, and runs only its own files.

import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

import type { Hono } from 'hono';

const TYPES: { readonly [extension: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** What every answer of the dashboard is sent with. The dashboard's own development server sends the same (apps/dashboard/src/csp.ts). */
export const DASHBOARD_HEADERS: { readonly [name: string]: string } = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Whether a path is the API's own, found or not: never the dashboard's. */
export const isApi = (path: string): boolean =>
  path === '/v1' || path.startsWith('/v1/') || path === '/health' || path === '/health/live';

/** A file of the dashboard's, as it is sent. */
export type DashboardFile = {
  readonly body: Buffer;
  readonly headers: { readonly [name: string]: string };
};

/**
 * The dashboard's build in `folder`, as a function of a request's path: the file it names, or
 * its page for any other path; undefined for the API's paths, and for what is not a path.
 * Throws at once when the folder has no dashboard in it, not at the first visit.
 */
export function dashboardFiles(folder: string): (pathname: string) => DashboardFile | undefined {
  const root = resolve(folder);
  const page = join(root, 'index.html');
  if (!statSync(page, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${root} has no index.html: build the dashboard first (pnpm --filter @acentric/dashboard build)`,
    );
  }
  const assets = join(root, 'assets') + sep;
  return (pathname) => {
    let path: string;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    if (isApi(path) || path.includes('\0')) return undefined;
    const wanted = resolve(root, `.${path}`);
    const inside = wanted === root || wanted.startsWith(root + sep);
    const file = inside && statSync(wanted, { throwIfNoEntry: false })?.isFile() ? wanted : page;
    return {
      body: readFileSync(file),
      headers: {
        ...DASHBOARD_HEADERS,
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        // Built files carry a hash in their names. The page itself is always fetched again.
        'Cache-Control': file.startsWith(assets)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      },
    };
  };
}

/** Serves the dashboard's files from `folder` on every GET the routes before it did not answer. */
export function serveDashboard(app: Hono, folder: string): void {
  const files = dashboardFiles(folder);
  app.get('*', (context, next) => {
    const file = files(new URL(context.req.url).pathname);
    return file === undefined ? next() : context.body(new Uint8Array(file.body), 200, file.headers);
  });
}
