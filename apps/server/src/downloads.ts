// What the engine hands out to be installed elsewhere, from one folder, with no key:
//
//   GET /install-cli.sh        installs the acentric command
//   GET /acentric.mjs          the acentric command, as one file
//   GET /install.sh            installs the machine program, enrols the machine and keeps it
//                              connected
//   GET /machine/<os>-<arch>   the machine program for a system, as one file: such as
//                              /machine/linux-x64
//
// Every answer of a server that hands out the command says which one, by the digest of its
// file: a command that was installed from an engine sees when the engine has another version.
// A machine is asked to take the engine's machine program by the digest of that.
//
// Each engine hands out the programs of its own build, so what is installed from it speaks what
// it speaks. A script has the engine's own address written in. Nothing here is secret: a
// machine's token is given on the command line that runs the script.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  { file: 'install.sh', script: true, from: 'apps/machine/install.sh' },
] as const;

/** The folder, in the one that is handed out, of the machine program: a file for each system. */
export const MACHINE_FOLDER = 'machine';

/** A system the machine program is built for, as its file is named: an OS and a processor. */
const SYSTEM = /^[a-z0-9]+-[a-z0-9]+$/;

/** The machine program for each system this engine hands it out for. */
export type MachinePrograms = {
  /** The systems, such as `linux-x64`. */
  readonly systems: readonly string[];
  /** The program for a system. Undefined for one this engine hands out none for. */
  bytes(system: string): Buffer | undefined;
  /** The SHA-256 of the program for a system, in hex. */
  build(os: string, arch: string): string | undefined;
};

/**
 * Reads the machine programs in a folder that is handed out: every file of `machine/` that is
 * named as a system is. None, for a folder with no such folder: an engine hands out the
 * program for the systems it was built with, and says of any other that it has none.
 */
export function machinePrograms(folder: string | undefined): MachinePrograms {
  const programs = new Map<string, { readonly bytes: Buffer; readonly build: string }>();
  const root = folder === undefined ? undefined : join(resolve(folder), MACHINE_FOLDER);
  if (root !== undefined && statSync(root, { throwIfNoEntry: false })?.isDirectory() === true) {
    for (const name of readdirSync(root).toSorted()) {
      if (!SYSTEM.test(name) || !statSync(join(root, name)).isFile()) continue;
      const bytes = readFileSync(join(root, name));
      programs.set(name, { bytes, build: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return {
    systems: [...programs.keys()],
    bytes: (system) => programs.get(system)?.bytes,
    build: (os, arch) => programs.get(`${os}-${arch}`)?.build,
  };
}

export type Downloads = {
  /** The folder the files are in. */
  readonly folder: string;
  /** Where people reach the server. Without it, where each request says it came to. */
  readonly publicUrl: string | undefined;
  /** The machine programs of the folder, when they were read already. */
  readonly machines?: MachinePrograms;
};

/**
 * Serves what is in the folder: each of `DOWNLOADS`, all of which must be there. It throws,
 * saying which is not and where it comes from, so that a server told a folder without them
 * does not start. It gives the digest of the command it hands out.
 */
export function serveDownloads(app: Hono, downloads: Downloads): string {
  const root = resolve(downloads.folder);
  let command = '';
  const headers = { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
  for (const { file, script, from } of DOWNLOADS) {
    if (statSync(join(root, file), { throwIfNoEntry: false })?.isFile() !== true) {
      throw new Error(`${root} has no ${file}: it is ${from}`);
    }
    const body = readFileSync(join(root, file));
    if (!script) {
      command = createHash('sha256').update(body).digest('hex');
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
  const machines = downloads.machines ?? machinePrograms(root);
  app.get(`/${MACHINE_FOLDER}/:system`, (context) => {
    const system = context.req.param('system');
    const bytes = machines.bytes(system);
    if (bytes === undefined) {
      const has = machines.systems.length === 0 ? 'none' : machines.systems.join(', ');
      return context.json(
        {
          error: {
            code: 'not_found',
            message: `This engine hands out no machine program for ${system}: it has ${has}`,
          },
        },
        404,
      );
    }
    return context.body(new Uint8Array(bytes), 200, {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
    });
  });
  return command;
}
