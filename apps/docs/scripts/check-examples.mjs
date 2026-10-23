#!/usr/bin/env node
/**
 * Type-checks the docs' TypeScript examples against the acentric packages,
 * so an example cannot drift from the API it shows, and runs the ones that
 * prove a claim, so a claim cannot drift from what the code does.
 *
 * A ```ts or ```tsx block is checked when it imports an `@acentric/` package
 * or its meta says `check` or `run`; `nocheck` skips it. A page's blocks form
 * one project: a block's `title="src/agent.ts"` is its file name, so blocks
 * on a page can import each other, and an untitled block gets a name of its
 * own. Each page is checked as its own project, strictly, as a new project
 * from `npm create acentric` is.
 *
 * Once a page type-checks, each block marked `run` is run with Node, and
 * fails the check if it exits with an error, such as a failed `node:assert`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const content = join(root, 'src/content');
// Under the docs' node_modules, so the examples resolve the acentric packages
// the docs depend on.
const out = join(root, 'node_modules/.examples');

const nav = await readFile(join(root, 'src/nav.ts'), 'utf8');
const slugs = [...nav.matchAll(/slug: '([^']*)'/g)].map((match) => match[1]);
/** As `fileOf` in nav.ts: a slug with pages beneath it lives in `index.mdx`. */
function fileOf(slug) {
  if (slug === '') return 'index.mdx';
  return slugs.some((other) => other.startsWith(`${slug}/`)) ? `${slug}/index.mdx` : `${slug}.mdx`;
}

/** The checked TypeScript blocks in a page's source. */
function blocks(source) {
  const found = [];
  for (const match of source.matchAll(/^```(ts|tsx)([^\n]*)\n([\s\S]*?)^```\s*$/gm)) {
    const [, language, meta, code] = match;
    if (/\bnocheck\b/.test(meta)) continue;
    const run = /\brun\b/.test(meta);
    if (!run && !/\bcheck\b/.test(meta) && !/from ['"]@acentric\//.test(code)) continue;
    const title = /title=(["'])(.*?)\1/.exec(meta)?.[2];
    const line = source.slice(0, match.index).split('\n').length + 1;
    found.push({ language, title, code, line, run });
  }
  return found;
}

await rm(out, { recursive: true, force: true });
/** Where each written file came from, for reporting errors against the page. */
const origins = new Map();

/**
 * Writes a page's checked blocks as a project, returning its folder and the
 * files to run, or null with no blocks.
 */
async function project(slug) {
  const page = fileOf(slug);
  const path = join(content, page);
  if (!existsSync(path)) return null;
  const found = blocks(await readFile(path, 'utf8'));
  if (found.length === 0) return null;
  const dir = join(out, slug === '' ? 'index' : slug.replaceAll('/', '__'));
  const runs = [];
  await Promise.all(
    found.map(async (block, index) => {
      const name = block.title ?? `example-${index + 1}.${block.language}`;
      const file = join(dir, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, block.code);
      const origin = { page: `src/content/${page}`, line: block.line };
      origins.set(file, origin);
      if (block.run) runs.push({ name, origin });
    }),
  );
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        jsx: 'react-jsx',
        verbatimModuleSyntax: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        // Emitted for running, and only when the page type-checks.
        outDir: 'built',
        rootDir: '.',
        noEmitOnError: true,
        // Examples run on Node, and tests use `node:assert`.
        types: ['node'],
      },
      include: ['**/*.ts', '**/*.tsx'],
    }),
  );
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return { dir, runs };
}

const projects = (await Promise.all(slugs.map(project))).filter((found) => found !== null);

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const problems = [];
let ran = 0;
for (const { dir, runs } of projects) {
  const result = spawnSync(process.execPath, [tsc, '-p', dir], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) {
    for (const { name, origin } of runs) {
      const script = join(dir, 'built', name.replace(/\.tsx?$/, '.js'));
      const run = spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 60_000,
      });
      ran += 1;
      if (run.status === 0) continue;
      const why = run.error?.message ?? run.stderr.trim().split('\n').slice(0, 12).join('\n  ');
      problems.push(`${origin.page}:${origin.line}: ${name} failed when run:\n  ${why}`);
    }
    continue;
  }
  for (const report of `${result.stdout}${result.stderr}`.trim().split('\n')) {
    const at = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(report);
    // tsc names files relative to the folder it runs in.
    const origin = at === null ? undefined : origins.get(resolve(root, at[1]));
    problems.push(
      at === null || origin === undefined
        ? `${relative(root, dir)}: ${report}`
        : `${origin.page}:${origin.line + Number(at[2]) - 1}: ${at[4]}`,
    );
  }
}

for (const problem of problems) console.error(problem);
console.log(
  `${origins.size} examples in ${projects.length} pages checked, ${ran} run${problems.length ? `: ${problems.length} problems` : ''}.`,
);
process.exit(problems.length ? 1 : 0);
