/** A short excerpt of `text` around the first term that appears in it. */
export function excerpt(text: string, terms: readonly string[], length = 150): string {
  const lower = text.toLowerCase();
  const at =
    terms
      .map((term) => lower.indexOf(term.toLowerCase()))
      .filter((i) => i >= 0)
      .toSorted((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 40);
  const slice = text.slice(start, start + length);
  return `${start > 0 ? '…' : ''}${slice}${start + length < text.length ? '…' : ''}`;
}
