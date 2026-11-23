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

import { READ_LOGS, READ_RESULT } from './code.ts';
import type { ModelFamily } from './families.ts';
import { NOTICE_TAG } from './sent.ts';
import { TASK_IMAGES } from './tasks.ts';

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
  /** Whether another actor spawned it: it is told how a subagent works. */
  readonly spawned?: boolean;
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

function tasks(
  commands: boolean,
  code: boolean,
  schedules: boolean,
  family: ModelFamily | undefined,
): string {
  let what = 'A script';
  if (commands) what = code ? 'A command or a script' : 'A command';
  return `# Tasks

${what} is a task. The call waits for it as long as \`wait\` says. If it ends in that time, the call answers with its result. If not, the task goes on in the background and the call answers with its ID.

You are told when a background task ends, by a notice with its result. Until then there is nothing to check: do not start it again, sleep, or keep reading its output to see whether it is done. Do other work, or end your turn; the notice will set you to work again.

A message that reaches you while a call waits can move its task to the background too. The task was not interrupted.

- \`wait: 0\` starts a task without waiting: ${commands ? 'for a server, or ' : ''}for long work you can do other things beside.
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

function scripts(onMachine: boolean): string {
  return `# Scripts

\`code\` runs JavaScript that calls tools. Use it when a step takes several calls, or one call over many items: make them all in one script and return only what you need. Some of your tools can be called only from a script: \`code\` lists them.

${
  onMachine ? 'A script does not run on your machine. It' : 'A script'
} has no files, no shell, no network and no imports, and reaches the outside only through tools.

Inside a script:
- \`await tools.<name>(args)\` calls a tool. It resolves to the result, parsed when it is JSON, and throws when the call fails. \`Promise.all\` runs calls side by side.
- \`return value\` is your answer. \`text(value)\` adds to it before that, and \`console.log(...)\` is shown after it. \`image(x)\` shows you an image there: a base64 \`data:\` URL, or one image part of what a tool returned. At most ${String(TASK_IMAGES)} a script.
- \`exit()\` ends the script at once, keeping what it gave back.
- \`await sleep(seconds)\` waits.
- \`await searchTools("create an issue")\` finds tools by words, \`await describeTool(name)\` gives one tool's signature, and \`ALL_TOOLS\` lists every name and description.
- \`await ${READ_RESULT}("s3")\` gives what an earlier script returned, as data, and \`await ${READ_LOGS}("s3")\` what it printed: for a result that was too long to show whole.

Apart from those two, nothing of one script is there for the next. A script is a task: it can outlast its \`wait\`, and you are told when it ends.`;
}

const SUBAGENTS = `# Subagents

You can create other agents to work for you, of the kinds \`spawn_agent\` lists. A subagent has its own conversation and sees nothing of yours: all it knows is what you send it.

\`spawn_agent\` creates one, idle, under a name you choose, and \`message_agent\` gives it work. Brief it as you would a capable colleague who has just walked in: what you want and why, what you already know, what is out of scope, and what to send back.

It answers by a message, which arrives as a notice with its name. Until then you know nothing of its result: do not guess at it, and do not ask how it is getting on. Do work that does not overlap with its task, or end your turn. It keeps its conversation, so a follow-up needs no second briefing.

You can message a subagent at any time, while it works too: to change its task, add to it, or ask it for something.

Use subagents for independent work that can go on side by side. Do small things yourself, and do not also do what you handed over.

\`stop\` with a subagent's name stops it and everything it started.`;

const SPAWNED = `# You are a subagent

Another agent created you to do part of its work. It is \`parent\` here, and its messages reach you marked <message from="parent">: they are your instructions. It may send you more at any time, a change or a question, while you work too.

Your parent cannot see this conversation, not even the last thing you say. It receives only what you send with \`message_agent\` to \`parent\`. When the work is done, send one message with everything it needs: what you found or did, what you could not do, and anything it has to decide. Write it to stand alone: your parent has not seen what you saw. Then end your turn by saying only: Completed.

Do not send progress unless you were asked for it. Ask your parent when you cannot go on without an answer, and settle the rest yourself.

You keep this conversation after you report.`;

/** What the harness tells the model of an actor, before its agent's own instructions. */
export function scaffoldOf(actor: Scaffolded): string {
  const has = (tool: string): boolean => actor.tools.includes(tool);
  const commands = has('bash') && actor.machine !== null;
  const pieces = [NOTICES];
  if (commands || has('code')) {
    pieces.push(tasks(commands, has('code'), has('schedule'), actor.family));
  }
  if (commands && actor.machine !== null) pieces.push(machine(actor.machine, has('view_image')));
  if (has('code')) pieces.push(scripts(commands));
  if (has('spawn_agent')) pieces.push(SUBAGENTS);
  if (actor.spawned === true) pieces.push(SPAWNED);
  return pieces.join('\n\n');
}

/** The instructions a model is sent: the harness's, then its agent's own. */
export function instructionsOf(actor: Scaffolded, own: string): string {
  const scaffold = scaffoldOf(actor);
  return own.trim() === '' ? scaffold : `${scaffold}\n\n${own}`;
}
