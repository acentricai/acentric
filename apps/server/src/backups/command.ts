// `acentric-server backup`: a backup taken beside a server that runs on the data, by another
// process. To a file, it is written under a name of its own and named the file once it is whole.

import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { finished } from 'node:stream/promises';

import type { Settings } from '../settings.ts';
import { makeBackup } from './archive.ts';
import type { Manifest } from './archive.ts';

/** A backup of the server's data, to `file`, or to stdout without one. */
export async function backupTo(
  settings: Settings,
  version: string,
  file: string | undefined,
): Promise<Manifest> {
  if (file === undefined) {
    const manifest = await makeBackup({
      data: settings.data,
      out: process.stdout,
      version,
      kind: 'manual',
    });
    await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
    return manifest;
  }
  const partial = join(dirname(file), `.${basename(file)}.partial`);
  const out = createWriteStream(partial);
  try {
    const manifest = await makeBackup({ data: settings.data, out, version, kind: 'manual' });
    out.end();
    await finished(out);
    await rename(partial, file);
    return manifest;
  } catch (error) {
    out.destroy();
    await rm(partial, { force: true });
    throw error;
  }
}
