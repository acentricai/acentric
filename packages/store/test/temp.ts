// A folder for a test's databases, removed when the tests of the file are over.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

/** Gives the path of a database that does not exist yet, a new one each time it is called. */
export function databases(): () => string {
  const dir = mkdtempSync(join(tmpdir(), 'acentric-store-'));
  let made = 0;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => join(dir, `${String(++made)}.sqlite`);
}
