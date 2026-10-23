/** One page: its heading, body, previous and next pages, and contents. */
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Link } from '@tanstack/react-router';
import type { MDXProps } from 'mdx/types';
import { IconArrowLeft, IconArrowRight, IconCheck, IconCopy } from '@tabler/icons-react';
import { hrefOf, neighbours, sectionOf, type Page } from '../nav';
import { loadMarkdown } from '../content';
import { site } from '../site';
import { mdxComponents } from './mdx';
import { Toc } from './Toc';

export function DocPage({ page, Body }: { page: Page; Body: ComponentType<MDXProps> }) {
  const article = useRef<HTMLElement>(null);
  const section = sectionOf(page);
  const { previous, next } = neighbours(page);

  useEffect(() => {
    document.title = page.slug ? `${page.title} · ${site.name} Docs` : `${site.name} Docs`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', page.description);
  }, [page]);

  return (
    <div className="page">
      <main id="content" className="article-column" tabIndex={-1}>
        <header className="page-header">
          {section && page.slug !== '' && <p className="page-eyebrow">{section.title}</p>}
          <div className="page-title-row">
            <h1>{page.title}</h1>
            <CopyPage page={page} />
          </div>
          <p className="page-lead">{page.description}</p>
        </header>
        <article ref={article} className="prose">
          <Body components={mdxComponents} />
        </article>
        <footer className="page-footer">
          <nav className="pager" aria-label="Previous and next pages">
            {previous ? (
              <Link to={hrefOf(previous)} className="pager-link" rel="prev">
                <span className="pager-direction">
                  <IconArrowLeft size={14} stroke={1.6} aria-hidden /> Previous
                </span>
                <span className="pager-title">{previous.label ?? previous.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={hrefOf(next)} className="pager-link pager-next" rel="next">
                <span className="pager-direction">
                  Next <IconArrowRight size={14} stroke={1.6} aria-hidden />
                </span>
                <span className="pager-title">{next.label ?? next.title}</span>
              </Link>
            )}
          </nav>
        </footer>
      </main>
      <aside className="toc-column">
        <Toc article={article} version={page.slug} />
      </aside>
    </div>
  );
}

/** Copies the page as Markdown, for pasting into an editor or a model's context. */
function CopyPage({ page }: { page: Page }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  useEffect(() => setState('idle'), [page]);
  useEffect(() => {
    if (state !== 'copied' && state !== 'failed') return;
    const timer = setTimeout(() => setState('idle'), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    setState('copying');
    try {
      await navigator.clipboard.writeText(await loadMarkdown(page));
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  return (
    <button type="button" className="copy-page" onClick={copy} disabled={state === 'copying'}>
      {state === 'copied' ? (
        <IconCheck size={15} stroke={1.75} aria-hidden />
      ) : (
        <IconCopy size={15} stroke={1.5} aria-hidden />
      )}
      <span aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? "Couldn't copy"
            : state === 'copying'
              ? 'Copying…'
              : 'Copy page'}
      </span>
    </button>
  );
}
