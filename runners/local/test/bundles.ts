// Bundles test agents into the self-contained modules the runner deploys,
// as `acentric build` will.

import { createRequire } from 'node:module';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);

/** Bundles a module and everything it imports into one ES module. */
export async function bundle(
  entry: string,
  platform: 'neutral' | 'node' = 'node',
): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform,
    write: false,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`esbuild produced nothing for ${entry}`);
  return output.text;
}

export type ProbeBundles = { v1: string; v2: string; handlers: string; badHandlers: string };

let probes: Promise<ProbeBundles> | null = null;

/** The conformance probe, version 1 and 2, its handlers and the handlers with a reserved name. */
export function probeBundles(): Promise<ProbeBundles> {
  probes ??= (async () => {
    const [v1, v2, handlers, badHandlers] = await Promise.all([
      bundle(require.resolve('@acentric/conformance/probe/agent'), 'neutral'),
      bundle(require.resolve('@acentric/conformance/probe/agent-v2'), 'neutral'),
      bundle(require.resolve('@acentric/conformance/probe/handlers')),
      bundle(require.resolve('@acentric/conformance/probe/handlers-bad-name')),
    ]);
    return { v1, v2, handlers, badHandlers };
  })();
  return probes;
}
