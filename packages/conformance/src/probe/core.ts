// The probe: a test agent with no behaviour of its own. Every input says
// exactly what its step should do, so a scenario can drive a runner into
// any situation. Every accepted input is recorded in the log, so the order
// in which a runner delivered them is visible.
//
// Inputs:
//   declare { effects }    add effect requests to the ones that should exist,
//                          replacing any with the same key unless `raw`
//   drop { keys }          remove them, so the runner cancels them
//   abort { keys }         mark them abort
//   append { entries }     append log entries
//   report {}             append what the step saw of the log window
//   now {}                 append the step's now
//   show_config {}         append the config the step sees
//   window { start }       set what window returns
//   reject { error }       reject the input
//   throw {}               throw: a failed step
//   bad_output {}          return a snapshot that is not Json: a failed step
//   noop {}                change nothing
//
// A finished effect's result is appended as a `result` entry and its key is
// no longer declared. A config change is rejected if it holds
// `reject: true`. Otherwise it is appended, after a `config_seen` entry with
// the config its step saw in its state.

import type {
  Agent,
  EffectRequest,
  Init,
  Json,
  JsonObject,
  Step,
  StepResult,
} from '@acentric/types';

export type ProbeSnapshot = {
  /** The effects that should exist. */
  declared: EffectRequest[];
  /** What window returns. */
  windowStart: number;
};

const init: Init<ProbeSnapshot, JsonObject> = (config) => {
  if (config['rejectInit'] === true) return { error: 'init rejected' };
  const declared = config['effects'];
  return {
    snapshot: {
      declared: Array.isArray(declared) ? declared.filter(isRequest) : [],
      windowStart: 1,
    },
    append: [{ kind: 'init', body: config }],
  };
};

const step: Step<ProbeSnapshot, JsonObject> = (state, msg, now) => {
  const snapshot = state.snapshot;
  switch (msg.type) {
    case 'input':
      return input(snapshot, msg.kind, msg.payload, state.log, now, state.config);
    case 'effect':
      return {
        snapshot: {
          ...snapshot,
          declared: snapshot.declared.filter((request) => request.key !== msg.key),
        },
        append: [{ kind: 'result', body: { key: msg.key, kind: msg.kind, outcome: msg.outcome } }],
      };
    case 'config':
      if (msg.config['reject'] === true) return { error: 'config rejected' };
      return {
        snapshot,
        append: [
          { kind: 'config_seen', body: state.config },
          { kind: 'config', body: msg.config },
        ],
      };
    case 'migrated':
      return { snapshot, append: [{ kind: 'migrated', body: { from: msg.from } }] };
  }
};

function input(
  snapshot: ProbeSnapshot,
  kind: string,
  payload: JsonObject,
  log: { start: number; next: number; entries: readonly unknown[] },
  now: number,
  config: JsonObject,
): StepResult<ProbeSnapshot> {
  const recorded = { kind: 'input', body: { kind, payload } };
  const keys = strings(payload['keys']);
  switch (kind) {
    case 'declare': {
      const effects = payload['effects'];
      const added = Array.isArray(effects) ? effects.filter(isRequest) : [];
      const replaced = new Set(added.map((request) => request.key));
      // `raw` keeps requests with the same key, so a list can name a key twice.
      const kept =
        payload['raw'] === true
          ? snapshot.declared
          : snapshot.declared.filter((request) => !replaced.has(request.key));
      return { snapshot: { ...snapshot, declared: [...kept, ...added] }, append: [recorded] };
    }
    case 'drop':
      return {
        snapshot: {
          ...snapshot,
          declared: snapshot.declared.filter((request) => !keys.includes(request.key)),
        },
        append: [recorded],
      };
    case 'abort':
      return {
        snapshot: {
          ...snapshot,
          declared: snapshot.declared.map((request) =>
            keys.includes(request.key) ? { ...request, abort: true } : request,
          ),
        },
        append: [recorded],
      };
    case 'append': {
      const entries = payload['entries'];
      const appended = Array.isArray(entries) ? entries.filter(isAppend) : [];
      return { snapshot, append: [recorded, ...appended] };
    }
    case 'report':
      return {
        snapshot,
        append: [
          recorded,
          {
            kind: 'report',
            body: { start: log.start, next: log.next, entries: log.entries.length },
          },
        ],
      };
    case 'now':
      return { snapshot, append: [recorded, { kind: 'now', body: { now } }] };
    case 'show_config':
      return { snapshot, append: [recorded, { kind: 'config_now', body: config }] };
    case 'window': {
      const start = payload['start'];
      return {
        snapshot: { ...snapshot, windowStart: typeof start === 'number' ? start : 1 },
        append: [recorded],
      };
    }
    case 'reject':
      return { error: payload['error'] ?? 'rejected' };
    case 'throw':
      throw new Error('the probe threw');
    case 'bad_output':
      return { snapshot: { ...snapshot, windowStart: Number.NaN }, append: [recorded] };
    case 'noop':
      return { snapshot, append: [recorded] };
    default:
      return { error: `unknown input kind ${kind}` };
  }
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequest(value: Json): value is EffectRequest & JsonObject {
  return isObject(value) && typeof value['key'] === 'string' && typeof value['kind'] === 'string';
}

function isAppend(value: Json): value is { kind: string; body: Json } {
  return isObject(value) && typeof value['kind'] === 'string' && value['body'] !== undefined;
}

/** The probe's pure half, as both versions share it. */
export const probe: Omit<Agent<ProbeSnapshot, JsonObject>, 'version'> = {
  name: 'probe',
  init,
  step,
  effects: (state) => state.snapshot.declared,
  window: (snapshot) => snapshot.windowStart,
  view: (state) => ({ declared: state.snapshot.declared.length }),
};
