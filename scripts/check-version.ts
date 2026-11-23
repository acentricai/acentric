// Every package and the machine program have one version, which is what a release is called.
//
//   node scripts/check-version.ts            fails when any two differ, and prints the version
//   node scripts/check-version.ts v0.15.0    fails too unless the version is the one a tag names
//
// The release runs it with the tag it was started by, so that an image is never called what its
// programs do not say they are.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageDirs, readJson, ROOT } from './workspace.ts';

/** `major.minor.patch`, with an optional `-pre.release`: what a version may be. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const versions = new Map<string, string>();
for (const dir of packageDirs()) {
  const { version } = readJson(join(dir, 'package.json')) as { version?: unknown };
  versions.set(`${dir}/package.json`, String(version));
}
// The machine program takes its version from the Cargo workspace.
const cargo = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(ROOT, 'Cargo.toml'), 'utf8'),
);
versions.set('Cargo.toml', cargo?.[1] ?? 'none');

const all = new Set(versions.values());
if (all.size !== 1) {
  for (const [where, version] of versions) console.error(`  ${version}  ${where}`);
  console.error('The packages and the machine program do not have one version.');
  process.exit(1);
}
const version = [...all][0];
if (version === undefined || !VERSION.test(version)) {
  console.error(`The version ${String(version)} is not major.minor.patch.`);
  process.exit(1);
}

const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  console.error(`The tag ${tag} is not the version of this commit, v${version}.`);
  process.exit(1);
}
console.log(version);
