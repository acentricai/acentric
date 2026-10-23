/**
 * Every page, in reading order. The sidebar, previous/next links, search and
 * the page titles all come from here; a page's MDX file holds only its body.
 *
 * `slug` is the URL path without a leading slash ('' is the home page) and
 * names the file: `agents/inputs` is `content/agents/inputs.mdx`, and a slug
 * with pages beneath it lives in `index.mdx`.
 */
export type Page = {
  readonly slug: string;
  /** The page heading. */
  readonly title: string;
  /** The sidebar label, when shorter than the title. */
  readonly label?: string;
  /** One sentence under the heading; also the search snippet. */
  readonly description: string;
};

export type Section = {
  readonly title: string;
  readonly pages: readonly Page[];
};

export const sections: readonly Section[] = [
  {
    title: 'Get started',
    pages: [
      {
        slug: '',
        title: 'Acentric',
        label: 'Introduction',
        description: 'Agents written as pure reducers, run by any runner.',
      },
    ],
  },
  {
    title: 'Concepts',
    pages: [
      {
        slug: 'concepts',
        title: 'How an agent works',
        label: 'Overview',
        description: 'An agent describes how it behaves; a runner runs it.',
      },
      {
        slug: 'concepts/state',
        title: 'State',
        description: 'What a session keeps: a small snapshot, a log written once, and its config.',
      },
      {
        slug: 'concepts/messages',
        title: 'Messages',
        description: 'Everything that happens to a session reaches step as one of four messages.',
      },
      {
        slug: 'concepts/effects',
        title: 'Effects and handlers',
        description: 'An agent declares the effects it wants running; handlers do the I/O.',
      },
      {
        slug: 'concepts/view',
        title: 'The view',
        description: 'What callers see of a session, apart from what the agent keeps.',
      },
      {
        slug: 'concepts/runners',
        title: 'Runners',
        description: 'What every runner promises, and what each one chooses.',
      },
    ],
  },
];

export const pages: readonly Page[] = sections.flatMap((section) => section.pages);

export function findPage(slug: string): Page | undefined {
  const normalized = slug.replace(/^\/+|\/+$/g, '');
  return pages.find((page) => page.slug === normalized);
}

export function sectionOf(page: Page): Section | undefined {
  return sections.find((section) => section.pages.includes(page));
}

export function neighbours(page: Page): { previous?: Page; next?: Page } {
  const index = pages.indexOf(page);
  return { previous: pages[index - 1], next: pages[index + 1] };
}

export function hrefOf(page: Page): string {
  return `/${page.slug}`;
}

/** Whether some page's slug is nested under this one's, so its body lives in `index.mdx`. */
function hasChildren(slug: string): boolean {
  return pages.some((page) => page.slug !== slug && page.slug.startsWith(slug ? `${slug}/` : ''));
}

/** The content file a page's body lives in, relative to `src/content`. */
export function fileOf(page: Page): string {
  if (page.slug === '') return 'index.mdx';
  return hasChildren(page.slug) ? `${page.slug}/index.mdx` : `${page.slug}.mdx`;
}
