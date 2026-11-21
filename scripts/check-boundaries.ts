// Checks the workspace against boundaries.json, and fails when a package depends on what it
// may not, or its tsconfig.json does not say what it depends on. Run by `pnpm boundaries`.

import { posix } from 'node:path';

import { check } from './boundaries.ts';
import type { Package, Workspace } from './boundaries.ts';
import { packageDirs, readJson } from './workspace.ts';

type Manifest = {
  readonly name: string;
  readonly dependencies?: { readonly [name: string]: string };
  readonly devDependencies?: { readonly [name: string]: string };
  readonly peerDependencies?: { readonly [name: string]: string };
  readonly optionalDependencies?: { readonly [name: string]: string };
};

type TsConfig = { readonly references?: readonly { readonly path: string }[] };

/** The folders a tsconfig.json references, from the root: `from` is the folder it is in. */
function referencesOf(config: TsConfig, from: string): string[] {
  return (config.references ?? []).map((reference) =>
    posix.normalize(posix.join(from, reference.path)),
  );
}

const dirs = packageDirs();
const manifests = dirs.map((dir) => readJson(`${dir}/package.json`) as Manifest);
const names = new Set(manifests.map((manifest) => manifest.name));

const packages: Package[] = dirs.map((dir, index) => {
  const manifest = manifests[index] as Manifest;
  const named = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  }).filter(([name]) => names.has(name));
  return {
    name: manifest.name,
    dir,
    dependencies: named.map(([name]) => name),
    unlinked: named
      .filter(([, version]) => !version.startsWith('workspace:'))
      .map(([name]) => name),
    references: referencesOf(readJson(`${dir}/tsconfig.json`) as TsConfig, dir),
  };
});

const workspace: Workspace = {
  allowed: readJson('boundaries.json') as Workspace['allowed'],
  packages,
  rootReferences: referencesOf(readJson('tsconfig.json') as TsConfig, '.'),
};

const problems = check(workspace);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`${String(packages.length)} packages keep to boundaries.json`);
