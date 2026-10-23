#!/usr/bin/env node
/**
 * Checks that every internal link in the docs names a page in `nav.ts`, that
 * its `#anchor` names a heading on that page, that every page in the nav
 * has a body, and that no page points readers at a private repository.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GithubSlugger from 'github-slugger';

const here = dirname(fileURLToPath(import.meta.url));
const content = join(here, '../src/content');

// The slugs, read from nav.ts as text so this runs on any Node version.
const nav = await readFile(join(here, '../src/nav.ts'), 'utf8');
const pages = [...nav.matchAll(/\{\s*slug: '([^']*)',([\s\S]*?)\n\s*\}/g)].map((match) => ({
  slug: match[1],
}));
/** As `fileOf` in nav.ts: a slug with pages beneath it lives in `index.mdx`. */
function fileOf(page) {
  if (page.slug === '') return 'index.mdx';
  const parent = pages.some((other) => other.slug.startsWith(`${page.slug}/`));
  return parent ? `${page.slug}/index.mdx` : `${page.slug}.mdx`;
}

const sources = new Map();
const problems = [];
const read = await Promise.all(
  pages.map(async (page) => {
    const file = join(content, fileOf(page));
    return { page, text: existsSync(file) ? await readFile(file, 'utf8') : null };
  }),
);
for (const { page, text } of read) {
  if (text === null) problems.push(`/${page.slug}: no content file (${fileOf(page)})`);
  else sources.set(page.slug, text);
}

/** Heading anchors as rehype-slug assigns them, code fences skipped. */
function anchors(source) {
  const slugger = new GithubSlugger();
  const found = new Set();
  let fenced = false;
  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && /^#{2,6}\s+(.*)$/.exec(line);
    if (match) {
      const text = match[1]
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_]/g, '');
      found.add(slugger.slug(text));
    }
  }
  return found;
}

const headings = new Map([...sources].map(([slug, source]) => [slug, anchors(source)]));

// The framework and platform repositories are private, so readers of the
// public docs can't open them.
const privateRepository = /github\.com\/(?:acentricai|ank1015)\/acentric(?:-cloud)?(?![\w-])/;

for (const [slug, source] of sources) {
  if (privateRepository.test(source)) {
    problems.push(`/${slug}: points to a private repository`);
  }
  const prose = source.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '');
  const links = [...prose.matchAll(/\]\((\/[^)\s]*)\)|href="(\/[^"]*)"/g)].map(
    (match) => match[1] ?? match[2],
  );
  for (const link of links) {
    const [path, anchor] = link.split('#');
    const requested = path.replace(/^\/+|\/+$/g, '');
    const target = requested;
    if (!sources.has(target) && !pages.some((page) => page.slug === target)) {
      problems.push(`/${slug}: links to ${link}, which isn't a page`);
    } else if (anchor && !headings.get(target)?.has(anchor)) {
      problems.push(`/${slug}: links to ${link}, but /${target} has no heading #${anchor}`);
    }
  }
}

for (const problem of problems) console.error(problem);
console.log(
  `${sources.size} pages, links checked${problems.length ? `: ${problems.length} problems` : ''}.`,
);
process.exit(problems.length ? 1 : 0);
