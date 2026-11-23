// JSON as text for a person to read: pretty, like `JSON.stringify(value, null, 2)`,
// but bounded while it is written, so a huge or deeply nested record can
// neither stall the page nor throw.

export type JsonLimits = {
  /** Characters of output; past them it stops with `…`. */
  readonly maxChars: number;
  /** Nesting below this is written as `…`. */
  readonly maxDepth?: number;
  /** Values written in all; past them it stops with `…`. */
  readonly maxNodes?: number;
};

export type JsonText = {
  readonly text: string;
  /** False when a limit cut it short. */
  readonly complete: boolean;
};

class Stop extends Error {}

export function boundedJson(value: unknown, limits: JsonLimits): JsonText {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 200_000;
  const out: string[] = [];
  let length = 0;
  let nodes = 0;
  let complete = true;

  const write = (piece: string) => {
    if (length + piece.length > limits.maxChars) {
      out.push(piece.slice(0, Math.max(0, limits.maxChars - length)));
      complete = false;
      throw new Stop();
    }
    out.push(piece);
    length += piece.length;
  };

  const scalar = (item: unknown): string | undefined => {
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string':
        return JSON.stringify(item);
      case 'number':
        return Number.isFinite(item) ? String(item) : 'null';
      case 'boolean':
        return String(item);
      case 'bigint':
        return JSON.stringify(String(item));
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
      default:
        return undefined;
    }
  };

  const visit = (item: unknown, depth: number, indent: string) => {
    nodes += 1;
    if (nodes > maxNodes) {
      complete = false;
      throw new Stop();
    }
    const plain = scalar(item);
    if (plain !== undefined) return write(plain);
    if (typeof item !== 'object' || item === null) return write('null');
    if (depth >= maxDepth) {
      complete = false;
      return write(Array.isArray(item) ? '[…]' : '{…}');
    }
    const inner = `${indent}  `;
    if (Array.isArray(item)) {
      if (item.length === 0) return write('[]');
      write('[\n');
      item.forEach((each, index) => {
        write(inner);
        if (scalar(each) === undefined && (typeof each !== 'object' || each === null))
          write('null');
        else visit(each, depth + 1, inner);
        write(index === item.length - 1 ? '\n' : ',\n');
      });
      return write(`${indent}]`);
    }
    const entries = Object.entries(item as Record<string, unknown>).filter(
      ([, each]) => each !== undefined && typeof each !== 'function' && typeof each !== 'symbol',
    );
    if (entries.length === 0) return write('{}');
    write('{\n');
    entries.forEach(([key, each], index) => {
      write(`${inner}${JSON.stringify(key)}: `);
      visit(each, depth + 1, inner);
      write(index === entries.length - 1 ? '\n' : ',\n');
    });
    return write(`${indent}}`);
  };

  try {
    visit(value, 0, '');
  } catch (error) {
    if (!(error instanceof Stop)) return { text: '—', complete: false };
  }
  const text = out.join('');
  return { text: complete ? text : `${text}…`, complete };
}
