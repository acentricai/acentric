// `schedule`: a note the model sends its later self. It is a task that does nothing until its
// time, and whose ending is its firing: the notice of it carries the note, or what the agent's
// schedule handler makes of it. It fires once. To have it again, the model schedules again
// when it does.

import type { ActorId, Json, JsonObject } from '@acentric/protocol';

import { span } from './tasks.ts';
import type { TaskEnd, TaskKind } from './tasks.ts';

/** How late a schedule fires before its notice says that it was late. */
const LATE_MS = 60_000;

/** The longest a timer holds: some weeks. A schedule further off has its timer set again. */
const TIMER_MS = 2_000_000_000;

type Input = { readonly note: string; readonly at: number };

/** A time with its offset: `2026-11-19T14:05:00Z`, `2026-11-19T19:35:00+05:30`. */
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A schedule as it fires, as the agent's handler is given it. Times are in milliseconds. */
export type Fired = { readonly note: string; readonly dueAt: number; readonly firedAt: number };

export type ScheduleKindOptions = {
  /**
   * What the notice of a fired schedule says, by its actor's agent: undefined when the agent
   * has no handler. It throws when the handler fails.
   */
  readonly handle?: (actor: ActorId, fired: Fired) => Promise<string | undefined>;
  readonly clock?: () => number;
};

export function scheduleKind(options: ScheduleKindOptions = {}): TaskKind {
  const now = options.clock ?? Date.now;
  return {
    kind: 'schedule',
    prefix: 't',
    tool: {
      name: 'schedule',
      description:
        'Has a note sent to you at a later time. You are told nothing until then, and at that time the note arrives as a notice and sets you to work. It fires once. Write the note for yourself as you will be then, with what there is to do: it may be all you have to go on.',
      properties: {
        note: { type: 'string', description: 'What the notice will say.' },
        in: { type: 'number', description: 'How many seconds from now.' },
        at: {
          type: 'string',
          description: 'Or the time itself, with its offset, such as 2026-11-19T14:05:00Z.',
        },
      },
      required: ['note'],
    },
    // It is not waited for, and it has no time of its own to run out.
    alone: true,

    input(args: JsonObject): Json {
      const { note, in: after, at, ...rest } = args;
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) throw new Error(`${unknown} is not known`);
      if (typeof note !== 'string' || note.trim() === '') {
        throw new Error('note is what the notice will say, and is not empty');
      }
      if ((after === undefined) === (at === undefined)) {
        throw new Error('give one of `in`, a number of seconds, and `at`, a time');
      }
      let when: number;
      if (after !== undefined) {
        if (typeof after !== 'number' || !(after >= 0)) {
          throw new Error('in is a number of seconds, 0 or more');
        }
        when = now() + after * 1000;
      } else {
        if (typeof at !== 'string' || !WITH_OFFSET.test(at) || Number.isNaN(Date.parse(at))) {
          throw new Error('at is a time with its offset, such as 2026-11-19T14:05:00Z');
        }
        when = Date.parse(at);
      }
      return { note, at: Math.round(when) } satisfies Input;
    },

    // A schedule has no title: its notice is its note, whole. Here the note's first line names it.
    standing(task): string {
      const { at, note } = task.input as Input;
      const left = at - now();
      const first = note.trim().split('\n')[0] ?? '';
      const more = first.length > 80 || note.trim().includes('\n');
      return `${left <= 0 ? 'fires now' : `fires in ${span(left)}`} · ${first.slice(0, 80)}${more ? ' …' : ''}`;
    },

    started(task): string {
      const { at } = task.input as Input;
      const left = at - now();
      return `scheduled for ${stamp(at)}, ${left <= 0 ? 'which is now' : `in ${span(left)}`}`;
    },

    run(task, { stop, closing }): Promise<TaskEnd> {
      const { note, at } = task.input as Input;
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = (end: TaskEnd): void => {
          clearTimeout(timer);
          stop.removeEventListener('abort', stopped);
          closing.removeEventListener('abort', closed);
          resolve(end);
        };
        const stopped = (): void => {
          done({ status: 'done', text: 'It had not fired.' });
        };
        // The engine is going away: the next one fires it, at its time or as soon as it starts.
        const closed = (): void => {
          done({ status: 'lost', text: '' });
        };
        const fire = async (firedAt: number): Promise<void> => {
          // It has fired: a stop now comes too late to stop it.
          stop.removeEventListener('abort', stopped);
          let text = note;
          let problem: string | undefined;
          try {
            text = (await options.handle?.(task.actor, { note, dueAt: at, firedAt })) ?? note;
          } catch (error) {
            // The model is told its note, as it is without a handler.
            problem = error instanceof Error ? error.message : String(error);
          }
          const late = firedAt - at;
          if (late > LATE_MS) {
            text = `${text}\n[this was due at ${stamp(at)}, and comes ${span(late)} late: the engine was not running]`;
          }
          done({ status: 'done', text, ...(problem === undefined ? {} : { problem }) });
        };
        const wait = (): void => {
          const here = now();
          const left = at - here;
          if (left <= 0) {
            void fire(here);
            return;
          }
          // Set again until the time is here.
          timer = setTimeout(wait, Math.min(left, TIMER_MS));
        };
        if (stop.aborted) stopped();
        else if (closing.aborted) closed();
        else {
          stop.addEventListener('abort', stopped, { once: true });
          closing.addEventListener('abort', closed, { once: true });
          wait();
        }
      });
    },
  };
}
