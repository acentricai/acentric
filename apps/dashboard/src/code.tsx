// Code, coloured by its language: an agent's bundle as JavaScript, and schemas as JSON. Only the
// highlighter's core and these two languages are in the build.

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import { useMemo } from 'react';

import { CopyButton } from './machines/ui.tsx';
import { safeText } from './machines/text.tsx';
import './styles/code.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);

/** Past this many characters, code is shown as it is: colouring it would hold the page up. */
const MOST_COLOURED = 2_000_000;

export type Language = 'javascript' | 'json';

/**
 * A block of code with its copy button. Characters that would not show, or would reorder what
 * is read, are shown as escapes; the copy is of the code as it is.
 */
export function Code({
  text,
  language,
  what,
  className,
}: {
  text: string;
  language: Language;
  /** For assistive technology: what the copy button copies. */
  what: string;
  className?: string;
}) {
  const shown = useMemo(() => safeText(text, true), [text]);
  // The highlighter escapes what it is given: its HTML has nothing of the text's own in it.
  const html = useMemo(
    () =>
      shown.length > MOST_COLOURED
        ? undefined
        : hljs.highlight(shown, { language, ignoreIllegals: true }).value,
    [shown, language],
  );
  return (
    <div className={`json code${className === undefined ? '' : ` ${className}`}`}>
      {html === undefined ? (
        <pre className="json__code code__text" dir="ltr">
          {shown}
        </pre>
      ) : (
        <pre
          className="json__code code__text hljs"
          dir="ltr"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      <CopyButton value={text} what={what} />
    </div>
  );
}

/** A value as JSON, two spaces in. */
export function JsonCode({ value, what }: { value: unknown; what: string }) {
  return <Code text={JSON.stringify(value, null, 2)} language="json" what={what} />;
}
