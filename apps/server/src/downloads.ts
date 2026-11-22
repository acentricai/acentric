// What the engine hands out to be installed elsewhere, from one folder, with no key:
//
//   GET /install-cli.sh   installs the acentric command
//   GET /acentric.mjs     the acentric command, as one file
//
// Each engine hands out the programs of its own build, so what is installed from it speaks what
// it speaks. The script has the engine's own address written in. Nothing here is secret.

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Context, Hono } from 'hono';

/** Where the script says the engine is: put in its place when it is served. */
export const SERVER_MARK = '__SERVER__';

/** What a shell takes inside single quotes: an address of letters, digits and `:/.-_`. */
const PLAIN = /^https?:\/\/[A-Za-z0-9.:[\]_-]+(\/[A-Za-z0-9._~/-]*)?$/;

/** Where this engine is reached, as a request to it says: its public address when it has one. */
export function serverOf(context: Context, publicUrl: string | undefined): string {
  if (publicUrl !== undefined) return publicUrl.replace(/\/+$/, '');
  const url = new URL(context.req.url);
  // Behind a proxy that ends HTTPS, the request came in over HTTPS.
  const proto = context.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = proto === 'https' || proto === 'http' ? proto : url.protocol.replace(':', '');
  const host = context.req.header('host') ?? url.host;
  return `${scheme}://${host}`;
}

/** The files, and where each comes from in this repository. */
export const DOWNLOADS = [
  { file: 'install-cli.sh', script: true, from: 'apps/cli/install.sh' },
  {
    file: 'acentric.mjs',
    script: false,
    from: 'apps/cli/dist/acentric.mjs, which `pnpm build` makes',
  },
] as const;

export type Downloads = {
  /** The folder the files are in. */
  readonly folder: string;
  /** Where people reach the server. Without it, where each request says it came to. */
  readonly publicUrl: string | undefined;
};

/**
 * Serves what is in the folder: each of `DOWNLOADS`, all of which must be there. It throws,
 * saying which is not and where it comes from, so that a server told a folder without them
 * does not start.
 */
export function serveDownloads(app: Hono, downloads: Downloads): void {
  const root = resolve(downloads.folder);
  const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  for (const { file, script, from } of DOWNLOADS) {
    if (statSync(join(root, file), { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`${root} has no ${file}: it is ${from}`);
    }
    const body = readFileSync(join(root, file));
    if (!script) {
      app.get(`/${file}`, (context) =>
        context.body(body, 200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }),
      );
      continue;
    }
    const text = body.toString('utf8');
    app.get(`/${file}`, (context) => {
      const server = serverOf(context, downloads.publicUrl);
      // An address that could break out of the script's quotes is never written into it.
      if (!PLAIN.test(server)) {
        return context.json(
          {
            error: {
              code: 'invalid_request',
              message: 'This address cannot be written into the script',
            },
          },
          400,
        );
      }
      return context.body(text.replaceAll(SERVER_MARK, server), 200, {
        ...headers,
        'content-type': 'text/x-shellscript; charset=utf-8',
      });
    });
  }
}
