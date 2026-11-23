// What the engine tells of what its actors do, and what the API answers, as lines of the log and
// as metrics: a line for each request and each turn that ended, and for each call of a model
// that failed; counts and times of all of them.

import type { EngineObserver } from '@acentric/core';

import type { Logger } from './log.ts';
import type { Metrics } from './metrics.ts';

/** A request the API answered, as the app tells of it. */
export type Answered = {
  /** The API's route, such as actors.get; `health`, or `other` for what is not the API's. */
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly ms: number;
  readonly requestId?: string;
  /** Whose it was: a key's ID, or a person's. */
  readonly by?: string;
};

export type Observing = {
  readonly observer: EngineObserver;
  readonly answered: (request: Answered) => void;
  /** How many actors of this process are in a turn now. */
  readonly working: () => number;
};

const seconds = (ms: number): number => ms / 1000;

export function observing(logger: Logger, metrics: Metrics | undefined): Observing {
  const working = new Set<string>();
  return {
    working: () => working.size,
    observer: {
      turnStarted: ({ actor, agent }) => {
        working.add(actor);
        metrics?.turnsStarted.inc();
        logger.debug('turn started', { actor, agent });
      },
      turnEnded: ({ actor, agent, end, reason, durationMs }) => {
        working.delete(actor);
        metrics?.turnsEnded.inc({ end });
        if (durationMs !== undefined) metrics?.turnSeconds.observe(seconds(durationMs), { end });
        const fields = { actor, agent, end, reason, ms: durationMs };
        if (end === 'failed') logger.warn('turn ended', fields);
        else logger.info('turn ended', fields);
      },
      modelCalled: (call) => {
        const kind = call.kind ?? 'turn';
        const outcome = call.failure ?? 'ok';
        const labels = { provider: call.provider, model: call.model };
        metrics?.modelCalls.inc({ ...labels, kind, outcome });
        metrics?.modelSeconds.observe(seconds(call.durationMs), { provider: call.provider });
        const usage = call.usage;
        if (usage !== null) {
          metrics?.modelTokens.inc({ ...labels, type: 'input' }, usage.input);
          metrics?.modelTokens.inc({ ...labels, type: 'output' }, usage.output);
          metrics?.modelTokens.inc({ ...labels, type: 'cache_read' }, usage.cacheRead);
          metrics?.modelTokens.inc({ ...labels, type: 'cache_write' }, usage.cacheWrite);
          if (usage.cost !== undefined) metrics?.modelCost.inc(labels, usage.cost.total);
        }
        const fields = {
          actor: call.actor,
          agent: call.agent,
          kind,
          provider: call.provider,
          model: call.model,
          ms: call.durationMs,
        };
        if (call.failure === null) logger.debug('model called', fields);
        else logger.warn('model call failed', { ...fields, failure: call.failure });
      },
      toolFinished: ({ actor, agent, name, kind, isError, durationMs }) => {
        const outcome = isError ? 'error' : 'ok';
        metrics?.toolCalls.inc({ kind, outcome });
        metrics?.toolSeconds.observe(seconds(durationMs), { kind });
        logger.debug('tool called', { actor, agent, tool: name, kind, outcome, ms: durationMs });
      },
    },
    answered: ({ route, method, status, ms, requestId, by }) => {
      metrics?.requests.inc({ route, method, status: String(status) });
      metrics?.requestSeconds.observe(seconds(ms), { route });
      // The API's requests are told; what checks the server is up, and the dashboard's files,
      // only when debug is asked for.
      const fields = { method, route, status, ms: Math.round(ms), requestId, by };
      if (route === 'health' || route === 'other') logger.debug('request', fields);
      else logger.info('request', fields);
    },
  };
}
