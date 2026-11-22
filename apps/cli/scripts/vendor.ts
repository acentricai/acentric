// Makes src/vendored.ts: the `@acentric/agent` package as `acentric init` puts it in a project,
// where it stands alone. Its code is bundled into one file, and its type declarations are
// copied with those of `@acentric/protocol` beside them, so a project needs nothing of this
// repository and nothing that is published. Run by `pnpm build`, once both are built.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const agent = join(repo, 'packages', 'agent');
const protocol = join(repo, 'packages', 'protocol');

/** Every declaration file under `folder`, by its path within it, with its text. */
function declarationsOf(folder: string): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
    const path = join(entry.parentPath, entry.name);
    // Without the line that names its source map: the maps are not copied.
    const text = readFileSync(path, 'utf8').replace(/\n\/\/# sourceMappingURL=.*\n?$/, '\n');
    out.push([relative(folder, path), text]);
  }
  return out.toSorted(([a], [b]) => (a < b ? -1 : 1));
}

const bundled = await build({
  entryPoints: [join(agent, 'src', 'index.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  // A project has its own zod, and an agent's schemas are made with that one.
  external: ['zod'],
  logLevel: 'silent',
});
const [code] = bundled.outputFiles;
if (code === undefined) throw new Error('The agent package bundled to nothing');

const files: { [path: string]: string } = { 'index.js': code.text };
// The agent's declarations, with the protocol named by where its own are put.
for (const [path, text] of declarationsOf(join(agent, 'dist'))) {
  const up = '../'.repeat(path.split('/').length - 1) || './';
  files[path] = text.replaceAll(
    /from '@acentric\/protocol(\/[a-z-]+)?'/g,
    (_all, sub: string | undefined) => `from '${up}protocol${sub ?? '/index'}.ts'`,
  );
}
for (const [path, text] of declarationsOf(join(protocol, 'dist'))) {
  files[join('protocol', path)] = text;
}

const { version } = JSON.parse(readFileSync(join(agent, 'package.json'), 'utf8')) as {
  version: string;
};
const hash = createHash('sha256');
for (const [path, text] of Object.entries(files)) hash.update(`${path}\0${text}\0`);
// The version of the package, and what names this build of it.
const vendored = `${version}+${hash.digest('hex').slice(0, 10)}`;
files['package.json'] = `${JSON.stringify(
  {
    name: '@acentric/agent',
    version: vendored,
    description: 'What a developer writes an agent with: the Agent class, tool(), and their types.',
    license: 'Apache-2.0',
    type: 'module',
    exports: { '.': { types: './index.d.ts', default: './index.js' } },
    peerDependencies: { zod: '^4.0.0' },
  },
  null,
  2,
)}\n`;

writeFileSync(
  join(here, '..', 'src', 'vendored.ts'),
  `// Made by scripts/vendor.ts: do not edit.\n\n/** The version of the agent package vendored. */\nexport const AGENT_VERSION = ${JSON.stringify(vendored)};\n\n/** Its files, by their path in vendor/agent. */\nexport const AGENT_FILES: { readonly [path: string]: string } = ${JSON.stringify(files, null, 2)};\n`,
);
console.log(`vendored @acentric/agent ${vendored}: ${String(Object.keys(files).length)} files`);
