# @acentric/docs

The public developer docs for the acentric framework. The shell, styles and
fonts come from the Acentric Cloud docs site; the content is the framework's.

```sh
pnpm --filter @acentric/docs dev      # http://localhost:5175
pnpm --filter @acentric/docs check    # types, and every internal link
pnpm --filter @acentric/docs build    # check, then dist/
pnpm --filter @acentric/docs preview
```

## Layout

|                          |                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `src/nav.ts`             | Every page in reading order: slug, title, sidebar label, description. The sidebar, search and page titles come from it. |
| `src/content/`           | Page bodies, one MDX file per page. A slug with pages beneath it lives in `index.mdx`.                                  |
| `src/components/mdx.tsx` | What Markdown renders as, and the components pages use without importing them.                                          |
| `src/components/`        | The shell (header, sidebar, search), the page frame and "On this page".                                                 |
| `src/lib/search.ts`      | Full-text search, built in the browser the first time search opens.                                                     |
| `src/site.ts`            | Addresses the docs link to.                                                                                             |
| `src/styles/`            | `tokens.css` is the design system's, `site.css` the frame, `prose.css` the article.                                     |

Every page also gets its own `index.html` at build time, with its title,
description and canonical address, so deep links work on any static host.

## Writing a page

1. Add it to `nav.ts` in reading order, with a one-sentence description: it
   renders under the title and is the search snippet.
2. Write the body in `src/content/<slug>.mdx`. No `#` heading: the layout
   renders the title and description. `##` and `###` headings build "On this
   page".
3. Link to other pages by path (`/concepts#effects`); the check fails on a
   link to a page or heading that does not exist.

Components available in every page: `<Callout type="note" | "tip" | "warning" title?>`,
`<Steps>`, `<Cards>` with `<Card title href>`, and `<Tabs>` with `<Tab label>`.
A fence's `title="src/agent.ts"` names the file it shows.
