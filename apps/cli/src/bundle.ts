// An agent's file and everything it imports, as the one ES module the engine takes. It is built
// for no platform: an agent may use what every JavaScript runtime has, such as `fetch`, and
// nothing of Node's own, and an import of a Node module fails here, saying where it was.
//
// The bundler is the project's own esbuild, which `acentric init` adds to it: the command is one
// file, and carries no bundler of its own.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

import { Fail } from './fail.ts';

type Message = {
  readonly text: string;
  readonly location: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  } | null;
};

type Esbuild = {
  build(options: object): Promise<{ readonly outputFiles: readonly { readonly text: string }[] }>;
};

/** What the project's own packages are found with. */
const requireOf = (root: string): NodeJS.Require => createRequire(join(root, 'package.json'));

/** The project's esbuild. */
function esbuildOf(root: string): Esbuild {
  try {
    return requireOf(root)('esbuild') as Esbuild;
  } catch {
    throw new Fail(
      `the project at ${root} has no esbuild to bundle its agents with`,
      'install its packages (`npm install`), or add esbuild to it',
    );
  }
}

/** The version of the agent package the project's agents are written with. */
export function sdkVersion(root: string): string {
  const missing = new Fail(
    `the project at ${root} has no @acentric/agent to write its agents with`,
    'install its packages (`npm install`)',
  );
  let at: string;
  try {
    at = dirname(requireOf(root).resolve('@acentric/agent'));
  } catch {
    throw missing;
  }
  // Its package.json is above where its code is, wherever in the package that is.
  for (;;) {
    const file = join(at, 'package.json');
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === '@acentric/agent' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    const up = dirname(at);
    if (up === at) throw missing;
    at = up;
  }
}

/** The bundle of `file`, which is from `root`. */
export async function bundle(root: string, file: string): Promise<string> {
  const esbuild = esbuildOf(root);
  try {
    const result = await esbuild.build({
      entryPoints: [join(root, file)],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      target: 'es2022',
      logLevel: 'silent',
    });
    const [output] = result.outputFiles;
    if (output === undefined) throw new Fail(`bundling ${file} gave nothing`);
    return output.text;
  } catch (error) {
    const { errors } = error as { errors?: readonly Message[] };
    if (!Array.isArray(errors)) throw error;
    const lines = (errors as readonly Message[]).map((each) => {
      if (each.location === null) return each.text;
      const { file: where, line, column } = each.location;
      const path = relative(root, join(root, where)) || where;
      return `${path}:${String(line)}:${String(column)}: ${each.text}`;
    });
    throw new Fail(`${file} could not be bundled:\n  ${lines.join('\n  ')}`);
  }
}
