/**
 * Full-text search over every page, built in the browser the first time the
 * search dialog opens. Each page is split at its `##` and `###` headings, so a
 * result can link straight to the section that matched.
 */
import MiniSearch from 'minisearch';
import GithubSlugger from 'github-slugger';
import { loadSource } from '../content';
import { hrefOf, pages, sectionOf, type Page } from '../nav';

export type Hit = {
  readonly id: string;
  readonly href: string;
  readonly page: string;
  readonly section: string;
  /** The heading the match is under; absent for a page's introduction. */
  readonly heading?: string;
  readonly text: string;
};

type Entry = Hit & {
  readonly title: string;
};

let index: Promise<MiniSearch<Entry>> | undefined;

export function searchIndex(): Promise<MiniSearch<Entry>> {
  index ??= build().catch((error) => {
    index = undefined;
    throw error;
  });
  return index;
}

async function build(): Promise<MiniSearch<Entry>> {
  // A page that fails to load is left out rather than failing the whole index.
  const loaded = await Promise.allSettled(
    pages.map(async (page) => split(page, await loadSource(page))),
  );
  const entries = loaded.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  if (entries.length === 0) throw new Error('No pages to search');
  const search = new MiniSearch<Entry>({
    fields: ['title', 'heading', 'text'],
    storeFields: ['href', 'page', 'section', 'heading', 'text'],
    searchOptions: {
      boost: { title: 4, heading: 2.5 },
      prefix: true,
      fuzzy: 0.15,
      combineWith: 'AND',
    },
  });
  search.addAll(entries);
  return search;
}

/** The best hits for a query, from the fields the index stores. */
export function hitsFor(search: MiniSearch<Entry>, query: string, limit = 12): Hit[] {
  return search
    .search(query)
    .slice(0, limit)
    .map((result) => {
      const field = (name: string): string => {
        const value: unknown = result[name];
        return typeof value === 'string' ? value : '';
      };
      const heading = field('heading');
      const hit = {
        id: String(result.id),
        href: field('href'),
        page: field('page'),
        section: field('section'),
        text: field('text'),
      };
      return heading === '' ? hit : Object.assign(hit, { heading });
    });
}

function split(page: Page, source: string): Entry[] {
  const slugger = new GithubSlugger();
  const base = hrefOf(page);
  const section = sectionOf(page)?.title ?? '';
  const entries: Entry[] = [];
  let heading: string | undefined;
  let lines: string[] = [page.description];
  let inFence = false;

  const flush = () => {
    const text = plain(lines.join('\n'));
    const anchor = heading ? `#${slugger.slug(heading)}` : '';
    entries.push({
      id: `${base}${anchor}`,
      href: `${base}${anchor}`,
      page: page.title,
      section,
      heading,
      title: page.title,
      text,
    });
  };

  for (const line of source.split('\n')) {
    if (line.startsWith('```') || line.startsWith('~~~')) inFence = !inFence;
    const match = !inFence && /^#{2,3}\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = plain(match[1] ?? '');
      lines = [];
    } else if (!line.startsWith('import ')) {
      lines.push(line);
    }
  }
  flush();
  return entries;
}

/** Markdown and MDX reduced to the words a reader sees. */
function plain(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, ' ')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/<\/?[A-Z][^>]*>/g, ' ')
    .replace(/<\/?[a-z][^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/^\s*[-:]{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
