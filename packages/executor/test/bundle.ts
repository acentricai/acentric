// Builds an agent's source into the one module that is deployed, as the command will: with
// everything it imports inside it, for no platform in particular.

import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/** The module an agent's source builds to, and what it still imports from outside itself. */
export async function built(fixture: string): Promise<{ code: string; imports: string[] }> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url))],
    bundle: true,
    format: 'esm',
    // No platform's own modules are there to import: an import of one fails here.
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error(`${fixture} built to nothing`);
  const imports = Object.values(result.metafile.outputs).flatMap((one) =>
    one.imports.map((imported) => imported.path),
  );
  return { code: output.text, imports };
}

export async function bundle(fixture: string): Promise<string> {
  return (await built(fixture)).code;
}
