// Markdown as release notes write it: paragraphs whose lines are wrapped, lists with items that go
// on over lines, headings, fenced code, and inline code, bold and links. It makes elements, never
// HTML from the text, so nothing in the notes runs as the page.

import type { ReactNode } from 'react';

type Block =
  | { readonly type: 'heading'; readonly level: number; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly type: 'code'; readonly text: string };

const ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/** The blocks of `text`, in order. */
export function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).trimStart().startsWith('```')) {
        code.push(lines[index] as string);
        index += 1;
      }
      blocks.push({ type: 'code', text: code.join('\n') });
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length,
        text: heading[2] as string,
      });
      index += 1;
      continue;
    }
    const first = ITEM.exec(line);
    if (first !== null) {
      const ordered = /\d/.test(first[2] as string);
      const items: string[] = [];
      while (index < lines.length) {
        const item = ITEM.exec(lines[index] as string);
        if (item === null) break;
        const parts = [item[3] as string];
        index += 1;
        // An item goes on over the lines indented under it.
        while (
          index < lines.length &&
          /^\s+\S/.test(lines[index] as string) &&
          ITEM.exec(lines[index] as string) === null
        ) {
          parts.push((lines[index] as string).trim());
          index += 1;
        }
        items.push(parts.join(' '));
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const parts: string[] = [];
    while (
      index < lines.length &&
      (lines[index] as string).trim() !== '' &&
      ITEM.exec(lines[index] as string) === null &&
      !/^#{1,6}\s/.test(lines[index] as string) &&
      !(lines[index] as string).trimStart().startsWith('```')
    ) {
      parts.push((lines[index] as string).trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: parts.join(' ') });
  }
  return blocks;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Inline code, bold and links of a line, as elements; the rest as text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) out.push(text.slice(last, at));
    const [whole] = match;
    if (whole.startsWith('`')) {
      out.push(<code key={at}>{whole.slice(1, -1)}</code>);
    } else if (whole.startsWith('**')) {
      out.push(<strong key={at}>{inline(whole.slice(2, -2))}</strong>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(whole);
      const href = link?.[2] ?? '';
      // Only links of the web: a `javascript:` one is text.
      out.push(
        /^https?:\/\//.test(href) ? (
          <a key={at} href={href} target="_blank" rel="noopener noreferrer">
            {inline(link?.[1] ?? '')}
          </a>
        ) : (
          (link?.[1] ?? whole)
        ),
      );
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {blocksOf(text).map((block, at) => {
        if (block.type === 'heading') {
          return (
            <p key={at} className="md__heading">
              {inline(block.text)}
            </p>
          );
        }
        if (block.type === 'code') return <pre key={at}>{block.text}</pre>;
        if (block.type === 'list') {
          const items = block.items.map((item, n) => <li key={n}>{inline(item)}</li>);
          return block.ordered ? <ol key={at}>{items}</ol> : <ul key={at}>{items}</ul>;
        }
        return <p key={at}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
