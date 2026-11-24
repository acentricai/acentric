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
//   ran `show chart.png`    the output, then the image
//
// A command shows the model an image with `show`, a program of the daemon's on its PATH. The
// daemon keeps a copy of each and names it in the ending, and the image is read from the
// machine and checked here, against the model it is shown to.

import { posix } from 'node:path';

import type { ImagePart, Json, JsonObject, MachineId, ShownImage } from '@acentric/protocol';

import { IMAGE_BYTES, imageOf } from './images.ts';
import { MachineNotFound, MachineOffline, MachineRefused } from './machines.ts';
import type { CommandEnd, Machines } from './machines.ts';
import { SandboxAsleep } from './sandboxes.ts';
import { TASK_IMAGES, imageMark, span, unmarked } from './tasks.ts';
import type { TaskEnd, TaskKind } from './tasks.ts';

type Input = {
  readonly machine: MachineId;
  readonly command: string;
  /** Where it starts, with the actor's working directory already joined in. */
  readonly cwd: string;
  readonly timeout?: number;
  /**
   * The provider of the model, when the model is shown images: what the images a command
   * shows are checked against. Without it, they are not shown.
   */
  readonly images?: string;
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
 * wrote, cut at the start of a line, and then, each on a line of its own, that it was cut, the
 * images it showed, and how it ended. `images` is a line for each image: its mark, or why it is
 * not shown.
 */
export function renderCommand(
  end: CommandEnd,
  log: string | undefined,
  most: number,
  images: readonly string[] = [],
): string {
  // Its output is the command's: nothing in it is taken for an image's place.
  let shown = images.length === 0 ? (end.tail ?? '') : unmarked(end.tail ?? '');
  // The lines of its images are kept whole, and the output is cut to what is left.
  if (images.length > 0) most = Math.max(0, most - images.join('\n').length - 1);
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
  parts.push(...images);
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

/** What the images a command showed come to: a line for each, its mark or why it is not shown, and the images that are. */
type ShownLines = { readonly lines: readonly string[]; readonly images: ImagePart[] };

export type BashOptions = {
  /** Whether a provider's model is shown images: a command's images are shown to one that is. */
  readonly takesImages?: (provider: string, model: string) => boolean;
  /**
   * Before a command is started: has a machine that is a sandbox awake, and rejects with
   * `SandboxAsleep` when it cannot be had. See `sandboxes.ts`.
   */
  readonly wake?: (machine: MachineId) => Promise<void>;
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

  /** Reads the images a command showed from its machine, and checks each for its model. */
  const shownOf = async (input: Input, given: readonly ShownImage[]): Promise<ShownLines> => {
    const lines: string[] = [];
    const images: ImagePart[] = [];
    for (const [index, one] of given.entries()) {
      if (index >= TASK_IMAGES) {
        lines.push(`[${one.name} is not shown: a command shows at most ${String(TASK_IMAGES)}]`);
        continue;
      }
      if (input.images === undefined) {
        lines.push(`[${one.name} is not shown: your model is not shown images]`);
        continue;
      }
      let read;
      try {
        // One byte more than the most, so that a larger file is known to be one.
        read = await machines.read(input.machine, { path: one.path, max: IMAGE_BYTES + 1 });
      } catch (error) {
        let why: string;
        if (error instanceof MachineOffline) why = 'your machine is not connected';
        else if (error instanceof MachineNotFound) why = 'your machine was removed';
        else if (error instanceof MachineRefused || error instanceof SandboxAsleep) {
          why = error.message;
        } else throw error;
        lines.push(`[${one.name} could not be read: ${why}]`);
        continue;
      }
      const checked = imageOf(Buffer.from(read.data, 'base64'), one.name, input.images, read.size);
      if ('why' in checked) {
        lines.push(`[${checked.why}]`);
        continue;
      }
      lines.push(imageMark(images.length));
      images.push(checked.image);
    }
    return { lines, images };
  };

  const endOf = (end: CommandEnd, log: string | undefined, shown?: ShownLines): TaskEnd => {
    const lines = shown?.lines ?? [];
    const render = (most: number): string => renderCommand(end, log, most, lines);
    const rendered = {
      text: end.tail ?? '',
      render,
      ...(shown === undefined || shown.images.length === 0 ? {} : { images: shown.images }),
    };
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

    input(args: JsonObject, actor, limits, definition): Json {
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
        ...(definition !== undefined &&
        options.takesImages?.(definition.provider, actor.modelId) === true
          ? { images: definition.provider }
          : {}),
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
        try {
          // A sandbox that has gone to sleep is started again, and waited for. First: one that
          // sleeps is not on its way back by itself, however long it is given.
          await options.wake?.(input.machine);
        } catch (error) {
          if (error instanceof SandboxAsleep) return { status: 'failed', text: error.message };
          throw error;
        }
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
        const shown = end.images.length === 0 ? undefined : await shownOf(input, end.images);
        return endOf(end, logOf(input, ref), shown);
      } finally {
        stop.removeEventListener('abort', stopIt);
      }
    },
  };
}
