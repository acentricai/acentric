// Puts the repository's LICENSE in every package, so that each package that is packed has the
// licence in it. The copies are not kept in git. Run by `pnpm copy-license`, before a release.

import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageDirs, ROOT } from './workspace.ts';

const dirs = packageDirs();
for (const dir of dirs) copyFileSync(join(ROOT, 'LICENSE'), join(ROOT, dir, 'LICENSE'));
console.log(`LICENSE copied into ${String(dirs.length)} packages`);
