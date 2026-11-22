// `bash`: the kind of task that runs a command on the actor's machine.
//
// The task and the command are one thing with two halves. The task is the engine's: who waits
// for it, and how its ending is told. The command is the machine's: it runs there with or
// without the engine, and the machine keeps its timeout. This file joins them, and says how a
// command's ending reads.
//
//   echo hi                 hi
//   exit 1                  the output, then [exit 1 · 2.3s]
//   wrote nothing           (no output)
//   too long to carry       its end, then [showing the last 412 lines of 14,210 · all of it: <log>]
//   past its timeout        the output so far, then [stopped: timed out after 30s]

import { posix } from 'node:path';

import type { Json, JsonObject, MachineId } from '@acentric/protocol';

import { MachineNotFound, MachineOffline } from './machines.ts';
import type { CommandEnd, Machines } from './machines.ts';
import { span } from './tasks.ts';
import type { TaskEnd, TaskKind } from './tasks.ts';

type Input = {
  readonly machine: MachineId;
  readonly command: string;
  /** Where it starts, with the actor's working directory already joined in. */
  readonly cwd: string;
  readonly timeout?: number;
};

const count = (value: number): string => value.toLocaleString('en-US');

/** How many lines a text has. A last line with no newline after it is a line too. */
function linesOf(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * How a command's ending reads in at most `most` characters of its output: the end of what it
 * wrote, cut at the start of a line, and then, each on a line of its own, that it was cut and
 * how it ended.
 */
export function renderCommand(end: CommandEnd, log: string | undefined, most: number): string {
  let shown = end.tail ?? '';
  // The machine sends the end of the output alone when there was more of it, from wherever
  // that falls.
  const cutByMachine = (end.bytes ?? 0) > Buffer.byteLength(shown);
  let midLine = cutByMachine;
  if (shown.length > most) {
    midLine = shown[shown.length - most - 1] !== '\n';
    shown = shown.slice(-most);
  }
  const cut = cutByMachine || shown.length < (end.tail ?? '').length;
  if (midLine) {
    // Not from the middle of a line, unless one line is all there is.
    const firstBreak = shown.indexOf('\n');
    if (firstBreak !== -1 && firstBreak < shown.length - 1) shown = shown.slice(firstBreak + 1);
  }
  const parts: string[] = [];
  if (shown !== '') parts.push(shown.endsWith('\n') ? shown.slice(0, -1) : shown);
  if (cut) {
    parts.push(
      `[showing the last ${count(linesOf(shown))} lines of ${count(end.lines ?? 0)}${
        log === undefined ? '' : ` · all of it: ${log}`
      }]`,
    );
  }
  const ran = span(end.ranMs ?? 0);
  switch (end.status) {
    case 'exited':
      if (end.exit !== 0) {
        parts.push(`[exit ${end.exit === null ? 'unknown' : String(end.exit)} · ${ran}]`);
      } else if (parts.length === 0) {
        parts.push('(no output)');
      }
      break;
    case 'stopped':
      // Why it was stopped is the engine's to say, but for what only the machine does.
      if (end.stoppedBy === 'output') {
        parts.push(
          `[stopped by the machine after ${ran}: it wrote more than the machine keeps of one command]`,
        );
      }
      break;
    case 'lost':
    case 'failed':
      parts.push(end.error ?? 'It is gone');
      break;
  }
  return parts.join('\n');
}

export type BashOptions = {
  /**
   * How long a command has to end once it was told to stop, before the task is taken as
   * stopped whatever the machine says. Longer than the machine's own grace before it kills, so
   * that the machine's word arrives first.
   */
  readonly stopGraceMs?: number;
};

export function bashKind(machines: Machines, options: BashOptions = {}): TaskKind {
  const logOf = (input: Input, ref: { actor: string; task: string }): string | undefined =>
    machines.logOf(input.machine, ref);

  const endOf = (end: CommandEnd, log: string | undefined): TaskEnd => {
    const render = (most: number): string => renderCommand(end, log, most);
    const rendered = { text: end.tail ?? '', render };
    switch (end.status) {
      case 'exited':
        // Whatever its exit status: the command ran, and what it says is its result.
        return { status: 'done', ...rendered };
      case 'stopped':
        if (end.stoppedBy === 'output') return { status: 'failed', ...rendered };
        return {
          status: 'done',
          ...rendered,
          // A stop the engine asked for has its own account of who asked.
          ...(end.stoppedBy === 'timeout' ? { stoppedBy: 'timeout' } : { stoppedBy: 'person' }),
        };
      case 'failed':
        return { status: 'failed', text: `The command could not be started: ${end.error ?? ''}` };
      case 'lost':
        return { status: 'lost', ...rendered };
    }
  };

  return {
    kind: 'bash',
    prefix: 'b',
    tool: {
      name: 'bash',
      description:
        'Runs a command with bash on your machine, and answers with what it wrote and how it ended. Every command is a new process: nothing of one is there for the next but the files it left. A command has no input to read.',
      properties: {
        command: { type: 'string', description: 'The command, as bash takes it.' },
        cwd: {
          type: 'string',
          description:
            'The directory it starts in: absolute, from ~, or from your working directory. Your working directory without it.',
        },
      },
      required: ['command'],
    },
    timesOut: true,
    stopGraceMs: options.stopGraceMs ?? 15_000,

    available: (actor) => actor.machine !== null,

    input(args: JsonObject, actor, limits): Json {
      if (actor.machine === null) throw new Error('you have no machine');
      const { command, cwd, ...rest } = args;
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('command is a string that is not empty');
      }
      if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '')) {
        throw new Error('cwd is a path');
      }
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) throw new Error(`${unknown} is not known`);
      const own = actor.machine.cwd;
      let startIn = own;
      if (cwd !== undefined) {
        const fromRoot = cwd.startsWith('/') || cwd === '~' || cwd.startsWith('~/');
        startIn = fromRoot ? cwd : posix.join(own, cwd);
      }
      const input: Input = {
        machine: actor.machine.id,
        command,
        cwd: startIn,
        ...(limits.timeout === undefined ? {} : { timeout: limits.timeout }),
      };
      return input;
    },

    title(input: Json): string {
      const { command } = input as Input;
      const first = command.trim().split('\n')[0] ?? '';
      const more = first.length > 80 || command.trim().includes('\n');
      return `$ ${first.slice(0, 80)}${more ? ' …' : ''}`;
    },

    where(task): string | undefined {
      const log = logOf(task.input as Input, { actor: task.actor, task: task.id });
      return log === undefined ? undefined : `log ${log}`;
    },

    async run(task, { stop, closing }): Promise<TaskEnd> {
      const input = task.input as Input;
      const ref = { actor: task.actor, task: task.id };
      // A task that an engine before this one stored and never started: its machine's daemon
      // may still be on its way back to this one.
      if ((await machines.command(ref)) === undefined) {
        await machines.settled(input.machine, closing);
        if (closing.aborted) return { status: 'lost', text: '' };
      }
      try {
        // Called again for a task that is under way, this finds its command and starts none.
        await machines.start(input.machine, {
          ...ref,
          command: input.command,
          cwd: input.cwd,
          ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        });
      } catch (error) {
        if (error instanceof MachineOffline) {
          return {
            status: 'failed',
            text: `Your machine, ${input.machine}, is not connected: nothing was run. It may be back later.`,
          };
        }
        if (error instanceof MachineNotFound) {
          return {
            status: 'failed',
            text: `Your machine, ${input.machine}, was removed: nothing was run.`,
          };
        }
        throw error;
      }
      const stopIt = (): void => {
        // It has no command to stop, or the asking could not be stored: its ending says which.
        machines.stop(ref).catch(() => {});
      };
      if (stop.aborted) stopIt();
      else stop.addEventListener('abort', stopIt, { once: true });
      try {
        const end = await machines.ended(ref, closing);
        // The engine is going away: the command goes on, and this is not what the task ends with.
        if (end === undefined) return { status: 'lost', text: '' };
        return endOf(end, logOf(input, ref));
      } finally {
        stop.removeEventListener('abort', stopIt);
      }
    },
  };
}
