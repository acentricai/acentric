// The scenario format. A scenario is a JSON file: a list of actions, each
// followed by the runner settling, and expectations about what must then be
// true. Runners in any language can play it; `player.ts` plays it for
// runners written in TypeScript.

import type { Json, JsonObject } from '@acentric/types';

import type { GateOutcome } from './hook.js';

/** Features some scenarios need, which a runner may not offer. */
export type Feature = 'durable' | 'upgrade';

/** The probe bundles a scenario can create a session from. */
export type Bundle = 'probe' | 'probe-bad-handler-name';

export type Scenario = {
  name: string;
  /** The section of RUNNERS.md it checks. */
  section: string;
  /** Features the runner must offer, or the scenario is skipped. */
  requires?: Feature[];
  steps: ScenarioStep[];
};

export type ScenarioStep =
  /** Create the session from a probe bundle, version 1, with this config. */
  | { create: JsonObject; bundle?: Bundle }
  /** Send an input. */
  | { input: string; payload?: JsonObject }
  /** Send a config change. */
  | { configure: JsonObject }
  /** Finish the gate waiting under this key. */
  | { release: string; with: GateOutcome }
  /** Let real time pass, in milliseconds. Kept small. */
  | { wait: number }
  /** Stop the runner abruptly and start it again from what it kept. */
  | { crash: true }
  /** Upgrade the session to version 2 of the probe. */
  | { upgrade: '2' }
  | { expect: Expectation };

/** A running effect, as far as a scenario checks it. */
export type RunningExpectation = {
  key: string;
  kind?: string;
  attempt?: number;
  abort?: boolean;
  args?: Json;
};

export type Expectation = {
  /** The last create, input, config change or upgrade was accepted. */
  accepted?: true;
  /** The last create, input, config change or upgrade was rejected, with this error if given. */
  rejected?: Json | true;
  /** The last input or config change made its step fail. */
  failed?: true;
  /** The running effects, exactly, in any order. */
  running?: (string | RunningExpectation)[];
  /** Gates whose signal has fired. */
  signalled?: string[];
  /** The newest log entries, matched partly: each given field must match. */
  log?: { kind: string; body?: Json }[];
  /** The kinds of the whole log, in order. */
  logKinds?: string[];
  /** The snapshot, matched partly. */
  snapshot?: JsonObject;
};
