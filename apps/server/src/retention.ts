// What the server removes as it goes, so that what it keeps does not only grow: always, the
// sessions and links that expired, which nothing reads again; and, for as long as its settings
// say to keep each, archived actors with their conversations, the audit log, and usage. Then it
// gives what was removed back to the disk. Every hour, a minute after it starts, a batch at a
// time, so that it never holds the database for long.
//
// What is removed is still in the backups taken before: they go as those do.

import type { Audit, Engine } from '@acentric/core';
import type { SqliteStore } from '@acentric/store';

import type { Logger } from './log.ts';
import type { Metrics } from './metrics.ts';
import type { RetentionSettings } from './settings.ts';

/** What one run removed. */
export type Removed = {
  readonly sessions: number;
  readonly links: number;
  readonly actors: number;
  readonly auditEvents: number;
  readonly usage: number;
  /** Bytes given back to the disk. */
  readonly bytes: number;
};

const EVERY_MS = 3_600_000;
const FIRST_MS = 60_000;
/** How many of each are removed in one transaction. */
const BATCH = 500;
/** The most of each one run removes: what is left is the next run's. */
const MOST = 50_000;

export type RetentionOptions = {
  readonly engine: Engine;
  readonly store: SqliteStore;
  readonly audit: Audit;
  readonly logger: Logger;
  readonly metrics?: Metrics | undefined;
  readonly settings: RetentionSettings;
  readonly clock?: () => number;
};

export class Retention {
  readonly #options: RetentionOptions;
  readonly #clock: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: RetentionOptions) {
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  /** Runs a minute from now, and every hour after. */
  start(): void {
    this.#schedule(FIRST_MS);
  }

  #schedule(ms: number): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => {
      void this.run()
        .catch((error: unknown) => {
          this.#options.logger.error('removing old data failed', {}, error);
        })
        .finally(() => this.#schedule(EVERY_MS));
    }, ms);
    this.#timer.unref();
  }

  /** Removes now what has had its day, and says what it removed. One run at a time. */
  run(): Promise<Removed> {
    const done = this.#running.then(
      () => this.#run(),
      () => this.#run(),
    );
    this.#running = done.catch(() => {});
    return done;
  }

  async #run(): Promise<Removed> {
    const { engine, store, audit, logger, metrics, settings } = this.#options;
    const now = this.#clock();
    const { sessions, links } = await store.removeExpired(now);

    let actors = 0;
    if (settings.archivedMs !== undefined) {
      const before = now - settings.archivedMs;
      for (let seen = 0; seen < MOST && !this.#closed;) {
        const ids = await store.archivedBefore(before, BATCH);
        for (const id of ids) {
          try {
            actors += (await engine.deleteActor(id)).length;
          } catch (error) {
            // Unarchived, or gone, since it was found: it is not this run's.
            logger.debug('an archived actor was not deleted', {
              actor: id,
              why: error instanceof Error ? error.message : String(error),
            });
          }
        }
        seen += ids.length;
        if (ids.length < BATCH) break;
      }
    }
    const pruned = async (
      keptMs: number | undefined,
      prune: (before: number, limit: number) => Promise<number>,
    ): Promise<number> => {
      if (keptMs === undefined) return 0;
      let removed = 0;
      while (removed < MOST && !this.#closed) {
        const went = await prune(now - keptMs, BATCH);
        removed += went;
        if (went < BATCH) break;
      }
      return removed;
    };
    const auditEvents = await pruned(settings.auditMs, (before, limit) =>
      store.pruneAudit(before, limit),
    );
    const usage = await pruned(settings.usageMs, (before, limit) =>
      store.pruneUsage(before, limit),
    );
    const bytes = await store.freePages();

    const removed: Removed = { sessions, links, actors, auditEvents, usage, bytes };
    for (const [what, count] of Object.entries(removed)) {
      if (what !== 'bytes' && count > 0) metrics?.retentionRemoved.inc({ what }, count);
    }
    if (bytes > 0) metrics?.retentionBytes.inc({}, bytes);
    if (actors + auditEvents + usage > 0) {
      // What was removed by the settings is written down; what had expired is not news.
      await audit.record({
        by: { type: 'system' },
        action: 'retention.removed',
        detail: { actors, auditEvents, usage, bytes },
      });
      logger.info('removed old data', { actors, auditEvents, usage, bytes });
    } else if (sessions + links + bytes > 0) {
      logger.debug('removed what expired', { sessions, links, bytes });
    }
    return removed;
  }

  /** Stops, and waits for a run that is going on. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    await this.#running;
  }
}
