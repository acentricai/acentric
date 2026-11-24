// How values are written: times, durations, tokens, sizes and IDs.

export const NOTHING = '—';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `3m ago`, `2h ago`, `3d ago`; `now` under ten seconds; a date after a year. */
export function relative(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d ago`;
  return date(at);
}

/** `Nov 11, 2026`. */
export function date(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** The full time, for hovering: `2026-11-11 14:02:07`. */
export function fullTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(at)}`;
}

/** `Tue, Nov 24, 2026, 7:47 PM GMT+5:30`: a time to read as a sentence. */
export function longTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** `14:02:07`. */
export function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `14:02:07.120`: times in the log. */
export function clockMs(at: number): string {
  return `${clock(at)}.${pad(new Date(at).getMilliseconds(), 3)}`;
}

/** `14:02` today, `Nov 11 14:02` another day: when a run started. */
export function started(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return hm;
  const year = d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${hm}`;
}

/** `840ms`, `4.2s`, `3m 07s`, `2h 05m`. */
export function duration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const tenths = Math.floor(ms / 100) / 10;
    return `${tenths.toFixed(1)}s`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** `300`, `7.0k`, `31.2k`, `182k`, `1.2M`. */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}

/** `31.2k in · 2.1k out`, or what is known of it. */
export function tokens(input: number | undefined, output: number | undefined): string {
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${count(input)} in`);
  if (output !== undefined) parts.push(`${count(output)} out`);
  return parts.join(' · ');
}

/** `512 B`, `4.0 KB`, `30.2 KB`, `1.4 MB`, in units of 1024. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The UTF-8 size of a text. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The first `limit` bytes of a text, cut at a whole character. */
export function firstBytes(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  // A continuation byte starts 10xxxxxx: step back to the start of a character.
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** An ID cut in the middle when long: `act_8f2c…91ac`. Shown whole on hover. */
export function shortId(id: string, max = 20): string {
  if (id.length <= max) return id;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${id.slice(0, head)}…${id.slice(id.length - (keep - head))}`;
}

/** `actk_3f…a91c`. */
export function keyHint(prefix: string, lastFour: string): string {
  return `${prefix}…${lastFour}`;
}

/** The first line of a text, trimmed; empty when it has none. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/** `v12`. */
export const version = (n: number) => `v${n}`;

/** `1 message`, `2 messages`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
