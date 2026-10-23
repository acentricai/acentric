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
  {
    title: 'Why reducers',
    pages: [
      {
        slug: 'why',
        title: 'Why an agent is a reducer',
        label: 'Overview',
        description: "A loop keeps its state in a paused function; a reducer's state is data.",
      },
      {
        slug: 'why/testing',
        title: 'Testing without mocks',
        description: 'Feed step messages and check what it returns: no model, network or clock.',
      },
      {
        slug: 'why/effects',
        title: 'Effects you can see and cancel',
        description:
          'What should be running follows from the state, and cancelling is not declaring.',
      },
      {
        slug: 'why/one-at-a-time',
        title: 'One message at a time',
        description: 'A stop or a steer that arrives mid-reply is just the next message.',
      },
      {
        slug: 'why/upgrades',
        title: 'Upgrading live sessions',
        description: 'New code takes over a running session between two steps.',
      },
      {
        slug: 'why/portability',
        title: 'Same agent, any runner',
        description: 'One bundle runs unchanged on every runner that passes the same tests.',
      },
      {
        slug: 'why/replay',
        title: 'Replaying a session',
        description: 'Re-run what a session received, and get the same results.',
      },
      {
        slug: 'why/costs',
        title: 'What it costs',
        description: 'What the model asks of you, and when a plain loop is the better choice.',
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
