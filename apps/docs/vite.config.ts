import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import mdx from '@mdx-js/rollup';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeShiki from '@shikijs/rehype';
import { pages as allPages } from './src/nav.ts';
import { site } from './src/site.ts';

// Pages are MDX under src/content. Code is highlighted at build time, with a
// light and a dark theme emitted as CSS variables, so a reader's theme switch
// costs nothing at runtime and no highlighter ships to the browser.
const compile = mdx({
  remarkPlugins: [remarkGfm],
  rehypePlugins: [
    rehypeSlug,
    [
      rehypeShiki,
      {
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
        addLanguageClass: true,
        // ```ts title="src/agent.ts" names the file a block belongs to.
        parseMetaString: (meta: string) => {
          const title = /title=(["'])(.*?)\1/.exec(meta)?.[2];
          return title ? { 'data-title': title } : {};
        },
      },
    ],
  ],
});

// `page.mdx?raw` is a page's source text, for search and "Copy page", and
// Vite's own raw loader serves it. Only a bare import is compiled: the MDX
// plugin ignores the query and would otherwise compile both.
const pages: Plugin = {
  name: 'docs-pages',
  enforce: 'pre',
  transform(code, id) {
    if (id.includes('?')) return;
    return compile.transform.call(this, code, id);
  },
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Each page is a folder's index.html, which a static host serves at the
// folder's address: `/quickstart/`, the address that never redirects.
const address = (slug: string) => (slug ? `${site.url}/${slug}/` : `${site.url}/`);

// Every page gets its own `index.html`, carrying its title, description and
// canonical address, so a deep link works on any static host without a
// rewrite rule and a shared link previews with the right text. The app takes
// over once loaded. robots.txt and sitemap.xml list every page for search.
const pageFiles: Plugin = {
  name: 'docs-page-files',
  apply: 'build',
  async closeBundle() {
    const dist = join(import.meta.dirname, 'dist');
    const shell = await readFile(join(dist, 'index.html'), 'utf8');
    await Promise.all(
      allPages.map(async (page) => {
        const title = page.slug ? `${page.title} · ${site.name} Docs` : `${site.name} Docs`;
        const canonical = address(page.slug);
        const html = shell
          .replace(/<title>.*<\/title>/, `<title>${escape(title)}</title>`)
          .replace(
            /(<meta name="description" content=")[^"]*(")/,
            `$1${escape(page.description)}$2`,
          )
          .replace('</head>', `  <link rel="canonical" href="${escape(canonical)}" />\n  </head>`);
        const dir = join(dist, page.slug);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'index.html'), html);
      }),
    );
    await writeFile(
      join(dist, '404.html'),
      shell.replace(/<title>.*<\/title>/, `<title>Not found · ${site.name} Docs</title>`),
    );
    const urls = allPages
      .map((page) => `  <url><loc>${escape(address(page.slug))}</loc></url>`)
      .join('\n');
    await writeFile(
      join(dist, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    );
    await writeFile(
      join(dist, 'robots.txt'),
      `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`,
    );
  },
};

export default defineConfig({
  plugins: [pages, react({ include: /\.(mdx|tsx|ts)$/ }), pageFiles],
  server: { port: 5175, strictPort: true },
  build: {
    outDir: 'dist',
    // The published site carries no source maps; development serves its own.
    sourcemap: false,
    // Fonts are files, never data: URIs, so the CSP's font-src 'self'
    // admits them. Vite would otherwise inline the smallest.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
