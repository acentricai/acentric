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
const isApi = (path: string): boolean =>
  path === '/v1' || path.startsWith('/v1/') || path === '/health' || path === '/health/live';

/**
 * Serves the dashboard's files from `folder` on every GET the routes before it did not answer.
 * Throws at once when the folder has no dashboard in it, not at the first visit.
 */
export function serveDashboard(app: Hono, folder: string): void {
  const root = resolve(folder);
  const page = join(root, 'index.html');
  if (!statSync(page, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `${root} has no index.html: build the dashboard first (pnpm --filter @acentric/dashboard build)`,
    );
  }
  const assets = join(root, 'assets') + sep;

  app.get('*', (context, next) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(context.req.url).pathname);
    } catch {
      return next();
    }
    if (isApi(path) || path.includes('\0')) return next();
    const wanted = resolve(root, `.${path}`);
    const inside = wanted === root || wanted.startsWith(root + sep);
    const file = inside && statSync(wanted, { throwIfNoEntry: false })?.isFile() ? wanted : page;
    return context.body(readFileSync(file), 200, {
      ...DASHBOARD_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Built files carry a hash in their names. The page itself is always fetched again.
      'Cache-Control': file.startsWith(assets) ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });
}
