// Makes dist/acentric.mjs: the command as one file, which an engine serves for
// `install-cli.sh` to fetch. Run by `pnpm build`, once the command is built.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  version: string;
};

await build({
  entryPoints: [join(here, '..', 'dist', 'bin.js')],
  outfile: join(here, '..', 'dist', 'acentric.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'error',
  // The version it says it is.
  define: { ACENTRIC_BUILD_VERSION: JSON.stringify(version) },
  // What is bundled may ask for a module of Node's as CommonJS does.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
