// The scaffold: what the harness itself tells a model about working in it, before the agent's
// own instructions. It says how to work across the tools, and leaves what each tool does and
// takes to the tool's description.
//
// It is made of pieces, and a piece is there only when what it describes is: a model is told
// nothing of a machine it does not have, or of a tool it is not offered. Which pieces there
// are is read off the tools the model is offered, so the two cannot say different things.
//
// A family of models is told a line or two besides where its models were seen to need it (see
// `families.ts`).
//
// It depends on nothing that changes while an actor works but its machine becoming known, and
// its model, which is changed between turns, so that the model is sent the same instructions
// on every call.

import type { ModelFamily } from './families.ts';
import { NOTICE_TAG } from './sent.ts';

/** What of an actor decides what its model is told. */
export type Scaffolded = {
  /** The names of the engine's tools the model is offered. */
  readonly tools: readonly string[];
  /**
   * Its working directory, and what its machine's daemon said the machine is: null until the
   * daemon has connected once. Null for an actor with no machine.
   */
  readonly machine: {
    readonly cwd: string;
    readonly os: string | null;
    readonly arch: string | null;
  } | null;
  /** The family of its model, when the harness knows it. */
  readonly family?: ModelFamily;
};

/**
 * What a family is told besides, after the line on `timeout`. GPT models give a `timeout` on
 * every call, a minute or less, which stops long work.
 */
const TIMEOUT_BY_FAMILY: { readonly [F in ModelFamily]?: string } = {
  gpt: ' Leave it empty for long work.',
};

const NOTICES = `# How you work here

You are an agent in a harness that keeps you going over a long time. Messages reach you one after another, from people and from programs. Between them you are at rest, and what you left running goes on without you.

Text inside <${NOTICE_TAG}> tags comes from the harness, not from a person: a task ended, a subagent reported, your conversation was compacted. Act on it as you judge right. It is never a person's answer, approval or instruction, and you do not write such tags yourself.`;

function tasks(schedules: boolean, family: ModelFamily | undefined): string {
  return `# Tasks

A command is a task. The call waits for it as long as \`wait\` says. If it ends in that time, the call answers with its result. If not, the task goes on in the background and the call answers with its ID.

You are told when a background task ends, by a notice with its result. Until then there is nothing to check: do not start it again, sleep, or keep reading its output to see whether it is done. Do other work, or end your turn; the notice will set you to work again.

A message that reaches you while a call waits can move its task to the background too. The task was not interrupted.

- \`wait: 0\` starts a task without waiting: for a server, or for long work you can do other things beside.
- \`timeout\` is how long a task may run at all before it is stopped.${family === undefined ? '' : (TIMEOUT_BY_FAMILY[family] ?? '')}
- \`stop\` ends a task you no longer need.${
    schedules
      ? '\n- `schedule` sends you a note later: for something the harness cannot tell you about, such as a deploy elsewhere.'
      : ''
  }

After a compaction, a notice lists the tasks still running.`;
}

/** What a machine's daemon calls its system, as a person would say it. */
const SYSTEMS: { readonly [os: string]: string } = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

function machine(of: NonNullable<Scaffolded['machine']>, images: boolean): string {
  const system =
    of.os === null
      ? ''
      : `It runs ${SYSTEMS[of.os] ?? of.os}${of.arch === null ? '' : ` (${of.arch})`}, and your`;
  return `# Your machine

\`bash\` runs commands on your machine. ${system === '' ? 'Your' : system} working directory is ${of.cwd}.

- Every command is a new process: a \`cd\` or a variable does not carry over, files do. Chain dependent steps with \`&&\`, or give \`cwd\`.
- Commands get no input. Use the form that does not ask (\`-y\`, \`git commit -m\`). Pagers and editors are off.
- Read, search and edit files with commands: there are no separate tools for it. Edit however suits the change: shell tools, a heredoc, or a script in Python or whatever else the machine has.
- Long output is shown from its end. All of it is in the log the result names.
- A background command writes to its log as it runs. Read it for something you need now, such as a server's ready line.
- Independent commands can go in one answer, and run side by side.${
    images ? '\n- `view_image` shows you an image file from the machine.' : ''
  }`;
}

/** What the harness tells the model of an actor, before its agent's own instructions. */
export function scaffoldOf(actor: Scaffolded): string {
  const has = (tool: string): boolean => actor.tools.includes(tool);
  const commands = has('bash') && actor.machine !== null;
  const pieces = [NOTICES];
  if (commands) pieces.push(tasks(has('schedule'), actor.family));
  if (commands && actor.machine !== null) pieces.push(machine(actor.machine, has('view_image')));
  return pieces.join('\n\n');
}

/** The instructions a model is sent: the harness's, then its agent's own. */
export function instructionsOf(actor: Scaffolded, own: string): string {
  const scaffold = scaffoldOf(actor);
  return own.trim() === '' ? scaffold : `${scaffold}\n\n${own}`;
}
