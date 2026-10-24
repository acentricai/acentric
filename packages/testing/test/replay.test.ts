// The journal digest, Simulation.upgrade, and replay, faithful and what-if,
// over journals recorded the way a runner records them.

import { createHash } from 'node:crypto';

import type {
  Agent,
  JournalAnswer,
  JournalEntry,
  JsonObject,
  Kinds,
  LogEntry,
  Message,
} from '@acentric/types';
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  forReplay,
  journalDigest,
  replay,
  simulate,
  SimulationError,
} from '../src/index.js';
import type { ReplayAgent, Simulation } from '../src/index.js';

type V1 = { count: number; pending: string[] };
type V2 = { total: number; pending: string[] };
type Config = { by: number };
type AskKinds = { ask: { args: { n: number }; result: string } };

/** Counts by its config's step, asks an effect when told to, and logs the answers. */
const v1: Agent<V1, Config, AskKinds> = {
  name: 'counter',
  version: '1',
  init: () => ({ snapshot: { count: 0, pending: [] }, append: [{ kind: 'created', body: null }] }),
  step: ({ snapshot, config }, message) => {
    if (message.type === 'input') {
      if (message.kind === 'boom') throw new Error('boom');
      if (message.kind !== 'add') return { error: `no input ${message.kind}` };
      const count = snapshot.count + config.by;
      const pending =
        message.payload['ask'] === true
          ? [...snapshot.pending, `ask:${message.id}`]
          : snapshot.pending;
      return { snapshot: { count, pending }, append: [{ kind: 'added', body: count }] };
    }
    if (message.type === 'effect') {
      const pending = snapshot.pending.filter((key) => key !== message.key);
      return {
        snapshot: { ...snapshot, pending },
        append: [{ kind: 'answered', body: message.key }],
      };
    }
    if (message.type === 'config') {
      return typeof message.config['by'] === 'number' ? { snapshot } : { error: 'by is a number' };
    }
    return { snapshot };
  },
  effects: ({ snapshot }) =>
    snapshot.pending.map((key) => ({ key, kind: 'ask', args: { n: snapshot.pending.length } })),
};

/** Version 2 renames count to total, and logs its upgrade. */
const v2: Agent<V2, Config, AskKinds> = {
  name: 'counter',
  version: '2',
  init: () => ({ snapshot: { total: 0, pending: [] } }),
  migrate: (snapshot) => ({
    snapshot: {
      total: Number(snapshot['count']),
      pending: Array.isArray(snapshot['pending']) ? snapshot['pending'].map(String) : [],
    },
  }),
  step: ({ snapshot, config }, message) => {
    if (message.type === 'migrated') {
      return { snapshot, append: [{ kind: 'upgraded', body: message.from }] };
    }
    if (message.type === 'input' && message.kind === 'add') {
      const total = snapshot.total + config.by;
      return { snapshot: { ...snapshot, total }, append: [{ kind: 'added', body: total }] };
    }
    if (message.type === 'effect') {
      const pending = snapshot.pending.filter((key) => key !== message.key);
      return {
        snapshot: { ...snapshot, pending },
        append: [{ kind: 'answered', body: message.key }],
      };
    }
    return { snapshot };
  },
  effects: ({ snapshot }) =>
    snapshot.pending.map((key) => ({ key, kind: 'ask', args: { n: snapshot.pending.length } })),
};

type Any = Simulation<JsonObject, JsonObject, Kinds>;

/** Drives a simulation and records its journal, as a runner that keeps one would. */
function recorder(agent: ReplayAgent, config: JsonObject, now = 1_000) {
  let simulation: Any = simulate(agent, config, { now });
  let version = agent.version;
  const journal: JournalEntry[] = [];
  const digest = (appended: readonly LogEntry[] = []): string =>
    journalDigest(simulation.snapshot, simulation.config, appended);
  journal.push({ n: 1, type: 'init', version, now, config, digest: digest(simulation.log) });

  return {
    journal,
    get simulation(): Any {
      return simulation;
    },
    deliver(message: Message, at: number): JournalAnswer {
      simulation.advance(at - simulation.now);
      let answer: JournalAnswer;
      let entryDigest: string | undefined;
      try {
        const delivery =
          message.type === 'config'
            ? simulation.configure(message.config)
            : simulation.send(message, message.type === 'effect' ? message.key : null);
        answer = delivery.rejected === null ? 'accepted' : 'rejected';
        if (answer === 'accepted') entryDigest = digest(delivery.appended);
      } catch {
        answer = 'failed';
      }
      journal.push({
        n: journal.length + 1,
        type: 'step',
        version,
        now: simulation.now,
        message,
        answer,
        ...(entryDigest === undefined ? {} : { digest: entryDigest }),
      });
      return answer;
    },
    upgrade(next: ReplayAgent, at: number): void {
      simulation.advance(at - simulation.now);
      const from = version;
      simulation = simulation.upgrade(next, { migrated: false });
      version = next.version;
      journal.push({
        n: journal.length + 1,
        type: 'upgrade',
        version,
        from,
        now: at,
        digest: digest(),
      });
      this.deliver({ type: 'migrated', from }, at);
    },
  };
}

const input = (id: string, kind: string, payload: JsonObject = {}): Message => ({
  type: 'input',
  id,
  kind,
  payload,
});

/** A session on version 1: inputs, a rejection, a failure, an effect, and a config change. */
function v1Session() {
  const session = recorder(forReplay(v1), { by: 1 });
  session.deliver(input('a', 'add'), 1_010);
  session.deliver(input('b', 'add', { ask: true }), 1_020);
  session.deliver(input('c', 'nope'), 1_030);
  session.deliver(input('d', 'boom'), 1_040);
  session.deliver({ type: 'config', config: { by: 10 } }, 1_050);
  session.deliver({ type: 'effect', key: 'ask:b', kind: 'ask', outcome: { ok: 'yes' } }, 1_060);
  session.deliver(input('e', 'add'), 1_070);
  return session;
}

describe('the journal digest', () => {
  it('is SHA-256 of canonical JSON: sorted keys, no whitespace', () => {
    expect(canonicalJson({ b: [1, 'x', { d: null, c: true }], a: 0.5 })).toBe(
      '{"a":0.5,"b":[1,"x",{"c":true,"d":null}]}',
    );
    const expected = createHash('sha256')
      .update('[{"a":1},{"by":2},[{"body":"x","kind":"k"}]]')
      .digest('hex');
    expect(journalDigest({ a: 1 }, { by: 2 }, [{ kind: 'k', body: 'x' }])).toBe(expected);
  });

  it('does not depend on the order keys were written in', () => {
    expect(journalDigest({ a: 1, b: 2 }, {}, [])).toBe(journalDigest({ b: 2, a: 1 }, {}, []));
  });
});

describe('Simulation.upgrade', () => {
  it('migrates, keeps the log and running effects, and delivers migrated', () => {
    const one = simulate(v1, { by: 1 });
    one.input('add', { ask: true }, 'x');
    const two = one.upgrade(v2);
    expect(two.snapshot).toEqual({ total: 1, pending: ['ask:x'] });
    expect(two.running.map((effect) => effect.key)).toEqual(['ask:x']);
    expect(two.log.map((entry) => entry.kind)).toEqual(['created', 'added', 'upgraded']);
    two.ok('ask:x', 'yes');
    expect(two.log.at(-1)).toMatchObject({ kind: 'answered', body: 'ask:x' });
  });

  it('leaves the simulation as it was when migrate rejects', () => {
    const one = simulate(v1, { by: 1 });
    const refusing = { ...v2, migrate: () => ({ error: 'too old' }) };
    expect(() => one.upgrade(refusing)).toThrow(SimulationError);
    one.input('add', {});
    expect(one.snapshot.count).toBe(1);
  });
});

describe('configure', () => {
  it('gives step the current config and effects the new one, as a runner does', () => {
    const seen: number[] = [];
    const watching: Agent<V1, Config, AskKinds> = {
      ...v1,
      step: (state, message) => {
        if (message.type === 'config') seen.push(state.config.by);
        return v1.step(state, message, 0);
      },
      effects: ({ config }) => [{ key: `by:${config.by}`, kind: 'ask', args: { n: config.by } }],
    };
    const session = simulate(watching, { by: 1 });
    session.configure({ by: 5 });
    expect(seen).toEqual([1]);
    expect(session.config).toEqual({ by: 5 });
    expect(session.running.map((effect) => effect.key)).toEqual(['by:5']);
  });
});

describe('replay', () => {
  it('reproduces a session faithfully, entry by entry', () => {
    const session = v1Session();
    const result = replay(session.journal, forReplay(v1));
    expect(result.differs).toBeNull();
    expect(result.entries.map((entry) => entry.expected.answer)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'rejected',
      'failed',
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(result.simulation.snapshot).toEqual(session.simulation.snapshot);
    expect(result.simulation.log).toEqual(session.simulation.log);
  });

  it('crosses an upgrade on the version that ran each entry', () => {
    const session = v1Session();
    session.deliver(input('f', 'add', { ask: true }), 1_080);
    session.upgrade(forReplay(v2), 1_090);
    session.deliver({ type: 'effect', key: 'ask:f', kind: 'ask', outcome: { ok: 'ok' } }, 1_100);
    session.deliver(input('g', 'add'), 1_110);

    const result = replay(session.journal, [forReplay(v1), forReplay(v2)]);
    expect(result.differs).toBeNull();
    expect(result.simulation.snapshot).toEqual({ total: 32, pending: [] });
    expect(result.simulation.log).toEqual(session.simulation.log);
  });

  it('says where other code first differs, in what-if mode', () => {
    const session = v1Session();
    // The fix: counting by twice the config's step.
    const doubled: Agent<V1, Config, AskKinds> = {
      ...v1,
      step: (state, message, now) =>
        v1.step({ ...state, config: { by: state.config.by * 2 } }, message, now),
    };
    const result = replay(session.journal, forReplay(doubled), { mode: 'what-if' });
    expect(result.differs).toBe(2);
    expect(result.simulation.snapshot['count']).toBe(24);
  });

  it('skips upgrades and their migrated messages in what-if mode', () => {
    const session = v1Session();
    session.upgrade(forReplay(v2), 1_090);
    const result = replay(session.journal, forReplay(v1), { mode: 'what-if' });
    expect(result.entries.slice(-2).map((entry) => entry.actual)).toEqual([null, null]);
    expect(result.differs).toBeNull();
  });

  it('refuses a journal without its init, or a version it was not given', () => {
    const session = v1Session();
    expect(() => replay(session.journal.slice(1), forReplay(v1))).toThrow('init');
    session.upgrade(forReplay(v2), 1_090);
    expect(() => replay(session.journal, forReplay(v1))).toThrow('version 2');
  });
});
