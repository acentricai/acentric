// The agent's pure half: what it remembers and how it responds. It does no
// I/O. Anything that touches the world is an effect: the agent declares it,
// and a handler, or the runner itself, runs it.
//
// This agent keeps notes. Send it inputs:
//
//   add     { "text": "buy milk" }          adds a note
//   done    { "id": 1 }                     marks a note done
//   remind  { "id": 1, "inSeconds": 30 }    reminds you of a note later
//
// A reminder is an effect: while it is pending, `effects` declares a
// `@timer`. The runner fires it at the time, and `step` logs the reminder
// when its result arrives.

import type { Agent, JsonObject, NoConfig } from '@acentric/types';

type Note = { id: number; text: string; done: boolean };
type Reminder = { key: string; noteId: number; at: number };

/** What the agent remembers between messages. Rewritten by every step, so keep it small. */
export type Snapshot = { notes: Note[]; reminders: Reminder[]; nextId: number };

/** The effects the agent asks for, by kind. `@timer` is the runner's. */
export type NotesKinds = { '@timer': { args: { at: number }; result: null } };

const agent: Agent<Snapshot, NoConfig, NotesKinds> = {
  name: 'notes',
  version: '0.1.0',
  kinds: ['@timer'],

  init: () => ({ snapshot: { notes: [], reminders: [], nextId: 1 } }),

  step: ({ snapshot }, message, now) => {
    if (message.type === 'input') return input(snapshot, message.kind, message.payload, now);
    if (message.type === 'effect') {
      // A timer fired: log the reminder, and stop declaring it.
      const reminder = snapshot.reminders.find((r) => r.key === message.key);
      const note = snapshot.notes.find((n) => n.id === reminder?.noteId);
      const reminders = snapshot.reminders.filter((r) => r.key !== message.key);
      if (note === undefined || !('ok' in message.outcome))
        return { snapshot: { ...snapshot, reminders } };
      return {
        snapshot: { ...snapshot, reminders },
        append: [{ kind: 'reminder', body: { id: note.id, text: note.text } }],
      };
    }
    return { snapshot };
  },

  // The effects the agent wants running now. The runner starts new keys and
  // cancels keys that disappear.
  effects: ({ snapshot }) =>
    snapshot.reminders.map((r) => ({ key: r.key, kind: '@timer', args: { at: r.at } })),

  // What callers, such as the dev UI, see of the agent.
  view: ({ snapshot }) => ({
    open: snapshot.notes.filter((n) => !n.done).length,
    done: snapshot.notes.filter((n) => n.done).length,
    reminders: snapshot.reminders.length,
  }),
};

export default agent;

/** Applies an input, or rejects it: a rejection changes nothing, and the caller is told why. */
function input(snapshot: Snapshot, kind: string, payload: JsonObject, now: number) {
  switch (kind) {
    case 'add': {
      const text = payload['text'];
      if (typeof text !== 'string' || text.trim() === '') return { error: 'add needs some text' };
      const note = { id: snapshot.nextId, text: text.trim(), done: false };
      return {
        snapshot: { ...snapshot, notes: [...snapshot.notes, note], nextId: note.id + 1 },
        append: [{ kind: 'added', body: note }],
      };
    }
    case 'done': {
      const note = snapshot.notes.find((n) => n.id === payload['id']);
      if (note === undefined) return { error: `no note ${JSON.stringify(payload['id'] ?? null)}` };
      return {
        snapshot: {
          ...snapshot,
          notes: snapshot.notes.map((n) => (n === note ? { ...n, done: true } : n)),
        },
        append: [{ kind: 'done', body: { id: note.id } }],
      };
    }
    case 'remind': {
      const note = snapshot.notes.find((n) => n.id === payload['id']);
      const inSeconds = payload['inSeconds'];
      if (note === undefined) return { error: `no note ${JSON.stringify(payload['id'] ?? null)}` };
      if (typeof inSeconds !== 'number' || inSeconds <= 0)
        return { error: 'remind needs inSeconds above 0' };
      const at = now + inSeconds * 1000;
      const reminder = { key: `remind:${note.id}:${at}`, noteId: note.id, at };
      return { snapshot: { ...snapshot, reminders: [...snapshot.reminders, reminder] } };
    }
    default:
      return { error: `unknown input ${kind}: send add, done or remind` };
  }
}
