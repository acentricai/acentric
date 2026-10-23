/**
 * "On this page": the article's `##` and `###` headings, with the one being
 * read marked. Read from the rendered article, so a page declares nothing.
 */
import { useEffect, useRef, useState } from 'react';

type Heading = {
  readonly id: string;
  readonly text: string;
  readonly depth: 2 | 3;
};

export function Toc({
  article,
  version,
}: {
  article: React.RefObject<HTMLElement | null>;
  version: string;
}) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [active, setActive] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const found = Array.from(
      article.current?.querySelectorAll<HTMLHeadingElement>('h2[id], h3[id]') ?? [],
    ).map((element) => ({
      id: element.id,
      text: Array.from(element.childNodes)
        .filter(
          (node) => !(node instanceof HTMLElement && node.classList.contains('heading-anchor')),
        )
        .map((node) => node.textContent)
        .join('')
        .trim(),
      depth: element.tagName === 'H2' ? (2 as const) : (3 as const),
    }));
    setHeadings(found);
    setActive(found[0]?.id);
  }, [article, version]);

  useEffect(() => {
    if (headings.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // The last heading above a reading line just under the header.
      const line = 120;
      let current = headings[0]?.id;
      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (element && element.getBoundingClientRect().top <= line) current = heading.id;
        else break;
      }
      // At the very bottom, the last heading, even if it never reaches the line.
      if (
        window.scrollY > 0 &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      ) {
        current = headings.at(-1)?.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [headings]);

  useEffect(() => {
    const link = list.current?.querySelector<HTMLElement>(
      `a[data-id="${CSS.escape(active ?? '')}"]`,
    );
    if (!link || !marker.current || !list.current) return;
    marker.current.style.transform = `translateY(${link.offsetTop}px)`;
    marker.current.style.height = `${link.offsetHeight}px`;
  }, [active, headings]);

  if (headings.length < 2) return null;

  return (
    <nav className="toc" aria-label="On this page">
      <p className="toc-title">On this page</p>
      <div className="toc-track">
        <span ref={marker} className="toc-marker" aria-hidden />
        <ol ref={list}>
          {headings.map((heading) => (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                data-id={heading.id}
                data-depth={heading.depth}
                aria-current={heading.id === active ? 'location' : undefined}
              >
                {heading.text}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
