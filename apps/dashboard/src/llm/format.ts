// How money, tokens and days are written on these pages. Days are the viewer's own: of the time
// zone the browser is in, which the server is asked to add usage up in.

import type { UsageTotals } from '@acentric/protocol';

/** The names of the providers the engine has. A provider is an ID: one not here is named by it. */
export const PROVIDER_NAMES: { readonly [provider: string]: string } = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  fireworks: 'Fireworks',
};

/** The providers an account is added to with an API key. A ChatGPT account is signed in, not given a key. */
export const KEY_PROVIDERS = ['anthropic', 'openai', 'fireworks'] as const;

/** A provider's name: its own, or its ID. */
export const providerName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/** The share of the input tokens that were read from a prompt cache, from 0 to 1; undefined with no input. */
export function cacheShare(
  totals: Pick<UsageTotals, 'cacheRead' | 'totalInput'>,
): number | undefined {
  return totals.totalInput === 0 ? undefined : totals.cacheRead / totals.totalInput;
}

/** A share as a percent: `62%`, `<1%` for a little, `—` for none to speak of. */
export function percent(share: number | undefined): string {
  if (share === undefined) return '—';
  if (share > 0 && share < 0.005) return '<1%';
  return `${String(Math.round(share * 100))}%`;
}

/** Dollars: `$1,234.56`, `$0.42`, and to four places under a cent, `$0.0042`; `$0.00` for none. */
export function dollars(value: number): string {
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A count, compact past ten thousand: `1,284`, `12.9K`, `4.2M`. */
export function compact(value: number): string {
  if (Math.abs(value) < 10_000) return value.toLocaleString('en-US');
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  if (Math.abs(value) < 1_000_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day as the ledger names it, `2026-11-20`, written `Nov 20`. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split('-');
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(date)}`;
}

/** The time zone the browser is in, which days are of. */
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The day a time is in, here, as the server names one: `2026-11-20`. */
export function dayOf(at: number): string {
  const day = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${String(day.getFullYear())}-${two(day.getMonth() + 1)}-${two(day.getDate())}`;
}

/** The days from `from` to `to`, here, each as the server names one. At most 400. */
export function daysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const at = new Date(from);
  at.setHours(0, 0, 0, 0);
  for (; at.getTime() <= to && out.length < 400; at.setDate(at.getDate() + 1)) {
    out.push(dayOf(at.getTime()));
  }
  return out;
}

/** Midnight here `days - 1` days before `now`'s day: the start of a range of `days` days ending then. */
export function rangeStart(days: number, now = Date.now()): number {
  const at = new Date(now);
  at.setHours(0, 0, 0, 0);
  at.setDate(at.getDate() - (days - 1));
  return at.getTime();
}

/** A change from what was to what is: `+12%`, `−8%`; undefined when there was nothing before. */
export function change(now: number, before: number): string | undefined {
  if (before === 0) return undefined;
  const share = (now - before) / before;
  const rounded = Math.round(share * 100);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${String(Math.abs(rounded))}%`;
}

/** How long a call took: `840 ms`, `2.4 s`, `1.2 min`. */
export function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
  return `${(ms / 60_000).toFixed(1).replace(/\.0$/, '')} min`;
}

/** Axis ticks from 0 to at least `max`, in three or four round steps. */
export function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((each) => each * power).find((each) => each >= rough) ?? rough;
  const out: number[] = [0];
  while ((out.at(-1) ?? 0) < max) out.push(Number(((out.at(-1) ?? 0) + step).toPrecision(12)));
  return out;
}
