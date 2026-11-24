// Whether there are versions after this server's: GitHub's releases of the engine, asked every
// few hours while someone looks, and now when asked to, but not more than once a minute. What is
// sent is the request alone, with no word of this server but its version in the user agent.
// ACENTRIC_UPDATE_CHECK=off asks nothing. Taking a version is not done here: whoever runs the
// server does that, as VERSIONS.md says.

import type { Release, Updater, Updates } from '@acentric/protocol';

/** Where the releases are read. */
const RELEASES = 'https://api.github.com/repos/acentricai/acentric/releases?per_page=50';
/** How long what was read is taken as so. */
const FRESH_MS = 6 * 3_600_000;
/** How soon after asking it is asked again, when someone asks for it. */
const AGAIN_MS = 60_000;
/** How long GitHub is waited for. */
const WAIT_MS = 10_000;

type Version = readonly [number, number, number];

/** `v0.16.1` or `0.16.1` as its numbers. Undefined for another, such as `v0.17.0-rc.1`. */
export function versionOf(text: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The version to take next from `current`, of those newer: the newest patch of the next minor,
 * or of this one when there is no next minor yet. A minor is not passed: VERSIONS.md promises
 * deployed agents and machines' daemons one version back.
 */
export function nextOf(current: string, newer: readonly string[]): string | null {
  const at = versionOf(current);
  if (at === undefined) return null;
  const reachable = newer
    .map((version) => ({ version, numbers: versionOf(version) }))
    .filter(
      (each): each is { version: string; numbers: Version } =>
        each.numbers !== undefined &&
        compare(each.numbers, at) > 0 &&
        each.numbers[0] === at[0] &&
        each.numbers[1] <= at[1] + 1,
    )
    .toSorted((a, b) => compare(b.numbers, a.numbers));
  return reachable[0]?.version ?? null;
}

type GitHubRelease = {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly published_at?: unknown;
  readonly html_url?: unknown;
  readonly body?: unknown;
};

/** The releases GitHub lists, of plain versions alone: no draft, and no `-rc` or the like. */
export function releasesOf(listed: unknown): Release[] {
  if (!Array.isArray(listed)) throw new Error('GitHub did not answer with a list of releases');
  const releases: Release[] = [];
  for (const each of listed as GitHubRelease[]) {
    if (each.draft === true || typeof each.tag_name !== 'string') continue;
    if (versionOf(each.tag_name) === undefined) continue;
    const at = typeof each.published_at === 'string' ? Date.parse(each.published_at) : NaN;
    if (Number.isNaN(at)) continue;
    releases.push({
      version: each.tag_name.replace(/^v/, ''),
      publishedAt: at,
      url: typeof each.html_url === 'string' ? each.html_url : '',
      notes: typeof each.body === 'string' ? each.body.trim() : '',
    });
  }
  return releases;
}

export class UpdateCheck {
  readonly #version: string;
  readonly #enabled: boolean;
  readonly #fetch: typeof fetch;
  readonly #clock: () => number;
  #releases: Release[] = [];
  #checkedAt: number | null = null;
  #error: string | null = null;
  #asking: Promise<void> | undefined;

  constructor(options: {
    /** This server's version. */
    readonly version: string;
    /** False for ACENTRIC_UPDATE_CHECK=off: nothing is asked. */
    readonly enabled: boolean;
    readonly fetch?: typeof fetch;
    readonly clock?: () => number;
  }) {
    this.#version = options.version;
    this.#enabled = options.enabled;
    this.#fetch = options.fetch ?? fetch;
    this.#clock = options.clock ?? Date.now;
  }

  /**
   * What there is after this version: asked again when it is old, or now when `refresh`; and
   * what the updater beside the server is doing, when there is one.
   */
  async status(refresh = false, updater: Updater | null = null): Promise<Updates> {
    if (this.#enabled) {
      const since = this.#checkedAt === null ? Infinity : this.#clock() - this.#checkedAt;
      if (since >= FRESH_MS || (refresh && since >= AGAIN_MS)) await this.#ask();
    }
    const current = versionOf(this.#version);
    const newer = this.#releases
      .filter((release) => {
        const numbers = versionOf(release.version);
        return current !== undefined && numbers !== undefined && compare(numbers, current) > 0;
      })
      .toSorted((a, b) =>
        compare(versionOf(b.version) as Version, versionOf(a.version) as Version),
      );
    return {
      current: this.#version,
      check: !this.#enabled ? 'off' : this.#error === null ? 'ok' : 'failed',
      checkedAt: this.#checkedAt,
      error: this.#error,
      latest: newer[0]?.version ?? null,
      next: nextOf(
        this.#version,
        newer.map((release) => release.version),
      ),
      releases: newer,
      updater,
    };
  }

  /** Asks GitHub, once at a time: who asks meanwhile waits for the same answer. */
  #ask(): Promise<void> {
    this.#asking ??= (async () => {
      try {
        const answer = await this.#fetch(RELEASES, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': `acentric-server/${this.#version}`,
          },
          signal: AbortSignal.timeout(WAIT_MS),
        });
        if (!answer.ok) throw new Error(`GitHub answered ${String(answer.status)}`);
        this.#releases = releasesOf(await answer.json());
        this.#error = null;
      } catch (error) {
        // What was read before stays: it is still what was there then.
        this.#error = `GitHub's releases could not be read: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        this.#checkedAt = this.#clock();
        this.#asking = undefined;
      }
    })();
    return this.#asking;
  }
}
