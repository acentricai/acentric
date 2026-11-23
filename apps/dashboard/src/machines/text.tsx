import { Fragment } from 'react';
// One policy for all untrusted text, including plain-text titles and labels.
const invisible = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
function textParts(value: string, lines = false) {
  const parts: { text: string; escape: boolean }[] = [];
  const matches = value.matchAll(new RegExp(invisible.source, 'gu'));
  let start = 0;
  for (const match of matches) {
    const ch = match[0];
    if (lines && (ch === '\n' || ch === '\t')) continue;
    if (match.index > start) parts.push({ text: value.slice(start, match.index), escape: false });
    const n = ch.codePointAt(0)!;
    parts.push({
      text: n <= 0xffff ? `\\u${n.toString(16).padStart(4, '0')}` : `\\u{${n.toString(16)}}`,
      escape: true,
    });
    start = match.index + ch.length;
  }
  if (start < value.length) parts.push({ text: value.slice(start), escape: false });
  return parts;
}
export const safeText = (value: string, lines = false) =>
  textParts(value, lines)
    .map((p) => p.text)
    .join('');
const hasInvisible = (value: string) => textParts(value).some((p) => p.escape);
export function displayText(value: string, lines = false) {
  return textParts(value, lines).map((p, i) =>
    p.escape ? (
      <span key={i} className="text-escape">
        {p.text}
      </span>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}
export function CopyNotice({ value }: { value: string }) {
  return hasInvisible(value) ? (
    <span className="note copy-notice">
      Contains invisible characters; copy includes the original.
    </span>
  ) : null;
}
