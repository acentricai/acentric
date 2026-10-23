/**
 * Page bodies. Each page is its own chunk, loaded when it is first visited or
 * hovered; the raw MDX behind "Copy page" and search is loaded only when one
 * of those is used.
 */
import type { ComponentType } from 'react';
import type { MDXProps } from 'mdx/types';
import { fileOf, type Page } from './nav';

type Body = ComponentType<MDXProps>;

const bodies = import.meta.glob<{ default: Body }>('./content/**/*.mdx');
const sources = import.meta.glob<string>('./content/**/*.mdx', {
  query: '?raw',
  import: 'default',
});

export async function loadBody(page: Page): Promise<Body> {
  const load = bodies[`./content/${fileOf(page)}`];
  if (!load) throw new Error(`No content for /${page.slug}`);
  return (await load()).default;
}

export async function loadSource(page: Page): Promise<string> {
  const load = sources[`./content/${fileOf(page)}`];
  if (!load) throw new Error(`No content for /${page.slug}`);
  return load();
}

/** Markdown a reader can paste elsewhere: the page's title and lead, then its body without MDX imports. */
export async function loadMarkdown(page: Page): Promise<string> {
  const source = await loadSource(page);
  const body = source.replace(/^import .*$\n?/gm, '').trim();
  return `# ${page.title}\n\n${page.description}\n\n${body}\n`;
}
