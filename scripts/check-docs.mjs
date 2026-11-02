#!/usr/bin/env node
/**
 * Checks the Markdown in the repository, so the docs cannot drift from the
 * code they describe.
 *
 * Links: in every tracked `.md` file, a relative link must name a file or
 * folder that exists, and its `#anchor` must name a heading in the Markdown
 * file it points to, as GitHub assigns them.
 *
 * Examples: in `docs/` and the root README, a ```ts or ```tsx block is type-checked when it
 * imports an `@acentric/` package or its meta says `check` or `run`;
 * `nocheck` skips it. A page's blocks form one project: a block's
 * `title="src/agent.ts"` is its file name, so blocks on a page can import
 * each other, and an untitled block gets a name of its own. Each page is
 * checked as its own project, strictly, as a new project from
 * `npm create acentric` is. Once a page type-checks, each block marked `run`
 * is run with Node, and fails the check if it exits with an error, such as a
 * failed `node:assert`.
 *
 * Run it after `pnpm build`: the examples import the built packages.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Under the root's node_modules, so the examples resolve the acentric
// packages the root depends on.
const out = join(root, 'node_modules/.docs-examples');

const markdown = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file.endsWith('.md') && existsSync(join(root, file)));

const problems = [];
const sources = new Map(
  await Promise.all(markdown.map(async (file) => [file, await readFile(join(root, file), 'utf8')])),
);

/** The text outside code fences. */
function prose(source) {
  return source.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '');
}

/** Heading anchors as GitHub assigns them, code fences skipped. */
function anchors(source) {
  const slugger = new GithubSlugger();
  const found = new Set();
  for (const line of prose(source).split('\n')) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (match === null) continue;
    const text = match[1]
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_]/g, '');
    found.add(slugger.slug(text));
  }
  return found;
}

const headings = new Map();
function headingsOf(file) {
  if (!headings.has(file)) headings.set(file, anchors(sources.get(file) ?? ''));
  return headings.get(file);
}

for (const [file, source] of sources) {
  for (const match of prose(source).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)|href="([^"]+)"/g)) {
    const link = match[1] ?? match[2];
    if (/^[a-z][a-z+.-]*:/i.test(link)) continue;
    if (link.startsWith('/')) {
      problems.push(`${file}: links to ${link}; use a relative path`);
      continue;
    }
    const [path, anchor] = link.split('#');
    const target = path === '' ? file : relative(root, resolve(root, dirname(file), path));
    if (path !== '' && !existsSync(join(root, target))) {
      problems.push(`${file}: links to ${link}, which does not exist`);
    } else if (anchor && target.endsWith('.md') && !headingsOf(target).has(anchor)) {
      problems.push(`${file}: links to ${link}, but ${target} has no heading #${anchor}`);
    }
  }
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
async function project(page) {
  const found = blocks(sources.get(page));
  if (found.length === 0) return null;
  const dir = join(out, page.replace(/\.md$/, '').replaceAll('/', '__'));
  const runs = [];
  await Promise.all(
    found.map(async (block, index) => {
      const name = block.title ?? `example-${index + 1}.${block.language}`;
      const file = join(dir, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, block.code);
      const origin = { page, line: block.line };
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

const pages = markdown.filter((file) => file === 'README.md' || file.startsWith('docs/'));
const projects = (await Promise.all(pages.map(project))).filter((found) => found !== null);

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
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
  `${sources.size} Markdown files, links checked; ${origins.size} examples in ${projects.length} pages checked, ${ran} run${problems.length ? `: ${problems.length} problems` : ''}.`,
);
process.exit(problems.length ? 1 : 0);
