// `code`: the kind of task that runs a script the model wrote. A script can do two things:
// compute, and call the tools it was given, which are the agent's own tools set to code mode
// and the tools of its MCP servers. It has no files, no network and no imports.
//
// A script runs in a QuickJS virtual machine on a thread of its own, which a stop of the engine
// loses. It is continued anyway. The machine runs a script the same way every time: its clock
// and its random numbers are given to it, and it only moves when it is handed the result of a
// call. So:
//
//   - what a script is run with is stored before it first runs;
//   - every call it makes is stored before the call is made, and the result is stored with its
//     place among the script's results;
//   - after a restart the script runs again from the top and is handed the stored results in
//     that order. It makes the calls it made before, which are not made again, and goes on from
//     where it was.
//
// A call that was under way when the engine stopped is made again when that is safe. When it
// is not, the script is told the call failed, and that it may or may not have run.

import { randomInt } from 'node:crypto';
import { Script } from 'node:vm';

import {
  CodemodeSandbox,
  renderDeclarations,
  renderToolSignature,
  toCodemodeIdentifier,
} from '@earendil-works/pi-codemode';
import type {
  CodemodeHostCall,
  CodemodeJsonSchema,
  CodemodeOutcome,
  CodemodeResult,
  CodemodeRun,
} from '@earendil-works/pi-codemode';

import { contentPartSchema } from '@acentric/protocol';
import type {
  Actor,
  ActorId,
  AgentDefinition,
  ImagePart,
  Json,
  JsonObject,
} from '@acentric/protocol';

import type { CallResult } from './executor.ts';
import { issuesText } from './executor.ts';
import type { Mcp, McpCatalog, McpResult } from './mcp.ts';
import type { ScriptCall, ScriptKept, Store } from './store.ts';
import { TASK_IMAGES, imageMark, unmarked } from './tasks.ts';
import type { TaskEnd, TaskKind } from './tasks.ts';
import { IMAGE_BYTES, megabytes } from './view-image.ts';

/** How long a script may run when its call does not say, in seconds. */
export const SCRIPT_TIMEOUT_S = 600;
/** How many calls one script may make. */
export const SCRIPT_CALLS = 10_000;
/** How many calls of one script are under way at once. More wait their turn. */
const AT_ONCE = 16;
/** How much memory a script's machine may use. */
const MEMORY_BYTES = 64 * 1024 * 1024;
/** The longest a timer is set for: what one can hold. */
const LONGEST_TIMER_MS = 2_000_000_000;

/** The names a script reads an earlier script with: what it returned, and what it printed. */
export const READ_RESULT = 'resultOf';
export const READ_LOGS = 'logsOf';

/** What a script calls that is the engine's own, and not a tool: it is not counted among its calls. */
const OWN_CALLS: readonly string[] = [
  'searchTools',
  'describeTool',
  'sleep',
  READ_RESULT,
  READ_LOGS,
];

/** A tool a script can call. */
export type ScriptTool = {
  /** How a script names it: `tools.<js>`. */
  readonly js: string;
  /** Its full name: the agent's own for a tool of the agent's, `mcp__<server>__<tool>` for a server's. */
  readonly name: string;
  readonly description: string;
  /** Its declaration, as TypeScript. */
  readonly signature: string;
  readonly retrySafe: boolean;
  /** For a server's tool: the server, and the server's own name for the tool. */
  readonly server?: string;
  readonly tool?: string;
};

/** What there is for a script to call, as it was when the script started. */
type Catalog = {
  readonly tools: readonly ScriptTool[];
  /** The servers that could not be asked what they offer when the script started. */
  readonly down: McpCatalog['down'];
};

const safe = (text: string): string => text.replaceAll(/[^A-Za-z0-9_]/g, '_');

const NO_SERVERS: McpCatalog = { tools: [], down: [] };

/** The agent's own tools that are for its model's scripts. */
const scriptToolsOf = (definition: AgentDefinition): AgentDefinition['tools'] =>
  definition.tools.filter((tool) => tool.codemode === true);

/** Everything a script of an agent can call: the agent's code mode tools, then its servers'. */
export function scriptTools(
  definition: AgentDefinition,
  servers: McpCatalog = NO_SERVERS,
): ScriptTool[] {
  const taken = new Set<string>();
  const unique = (wanted: string): string => {
    let js = wanted;
    for (let count = 2; taken.has(js); count += 1) js = `${wanted}_${String(count)}`;
    taken.add(js);
    return js;
  };
  const own = scriptToolsOf(definition).map((tool): ScriptTool => {
    const js = unique(toCodemodeIdentifier(tool.name));
    return {
      js,
      name: tool.name,
      description: tool.description,
      signature: renderToolSignature({
        name: js,
        inputSchema: tool.parameters as CodemodeJsonSchema,
      }),
      retrySafe: tool.retrySafe,
    };
  });
  const theirs = servers.tools.map((tool): ScriptTool => {
    const js = unique(`mcp__${safe(tool.server)}__${safe(tool.name)}`);
    return {
      js,
      name: js,
      description: tool.description,
      signature: renderToolSignature({
        name: js,
        ...(tool.inputSchema === undefined
          ? {}
          : { inputSchema: tool.inputSchema as CodemodeJsonSchema }),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: tool.outputSchema as CodemodeJsonSchema }),
      }),
      retrySafe: tool.retrySafe,
      server: tool.server,
      tool: tool.name,
    };
  });
  return [...own, ...theirs];
}

/** What `searchTools` answers with for one tool. */
export type Found = {
  readonly name: string;
  readonly description: string;
  readonly signature: string;
};

const foundOf = (tool: ScriptTool): Found => ({
  name: tool.js,
  description: tool.description,
  signature: tool.signature,
});

/**
 * Words that say nothing of what a tool does: they are in the descriptions of nearly every one,
 * and are not looked for.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be by can do does for from get gets give gives has have how i in into is it ' +
    'its me my of on one or so some than that the their them then there these this to use used uses ' +
    'using was what when where which who with you your'
  ).split(' '),
);

/** The words of a signature that are TypeScript's, not the tool's: not looked for in it. */
const SIGNATURE_WORDS: ReadonlySet<string> = new Set(
  'args string number boolean promise unknown null undefined array record object true false any void'.split(
    ' ',
  ),
);

/** How much a word found in each part of a tool counts: its name says most of what it is. */
export const SEARCH_WEIGHTS = { name: 3, server: 2, parameters: 1.5, description: 1 } as const;

/** BM25's numbers: how fast a word found again stops adding, and how much a long part counts against it. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** How much a query's word counts in a word it only begins, such as `doc` in `documentation`. */
const PREFIX_WEIGHT = 0.5;
/** A query's word is looked for at the start of others only from this length. */
const PREFIX_FROM = 3;

/** A tool that scores less than this share of the best match is not one. */
export const SEARCH_CUTOFF = 0.1;

/** A word without the endings that make it another form of itself: `tickets`, `creating`. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && /(ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The words of a text that a search looks for: split at case and punctuation, small ones left out. */
export function searchWords(text: string, skip: ReadonlySet<string> = STOP_WORDS): string[] {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !skip.has(word) && !STOP_WORDS.has(word))
    .map(stem);
}

type Part = keyof typeof SEARCH_WEIGHTS;

type Indexed = {
  readonly tool: ScriptTool;
  readonly parts: { readonly [P in Part]: readonly string[] };
};

function indexOf(tool: ScriptTool): Indexed {
  // The signature without the tool's own name, which is its name's part.
  const parameters = tool.signature.slice(Math.max(0, tool.signature.indexOf('(')));
  return {
    tool,
    parts: {
      name: searchWords(tool.tool ?? tool.name),
      server: searchWords(tool.server ?? ''),
      parameters: searchWords(parameters, SIGNATURE_WORDS),
      description: searchWords(tool.description),
    },
  };
}

/** How often `word` is in `words`: once for each word it is, and in part for each it begins. */
function frequency(words: readonly string[], word: string): number {
  let times = 0;
  for (const one of words) {
    if (one === word) times += 1;
    else if (word.length >= PREFIX_FROM && one.startsWith(word)) times += PREFIX_WEIGHT;
  }
  return times;
}

/**
 * The tools that match a query best, ranked by BM25 over each tool's name, server, parameters
 * and description, a word in its name counting most. Small words are not looked for, a word's
 * other forms are the same word, and a word few tools have counts for more than one most have.
 * A query that is a tool's name gives that tool first. With no words to look for, every tool
 * of the server asked for is a match.
 */
export function searchTools(
  tools: readonly ScriptTool[],
  query: string,
  options: { readonly limit?: number; readonly server?: string } = {},
): Found[] {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 8)));
  const among = tools.filter(
    (tool) => options.server === undefined || tool.server === options.server,
  );
  const exact = query.trim().toLowerCase();
  const named = (tool: ScriptTool): boolean =>
    tool.js.toLowerCase() === exact || tool.name.toLowerCase() === exact;
  const words = [...new Set(searchWords(query))];
  if (words.length === 0) {
    return among
      .toSorted((a, b) => Number(named(b)) - Number(named(a)) || a.js.localeCompare(b.js))
      .slice(0, limit)
      .map(foundOf);
  }
  const index = among.map(indexOf);
  const parts = Object.keys(SEARCH_WEIGHTS) as Part[];
  const average = Object.fromEntries(
    parts.map((part) => [
      part,
      index.reduce((sum, one) => sum + one.parts[part].length, 0) / Math.max(1, index.length),
    ]),
  ) as { [P in Part]: number };
  const rarity = new Map(
    words.map((word) => {
      const having = index.filter((one) =>
        parts.some((part) => frequency(one.parts[part], word) > 0),
      ).length;
      return [word, Math.log(1 + (index.length - having + 0.5) / (having + 0.5))];
    }),
  );
  const scored = index.map((one) => {
    let score = 0;
    for (const word of words) {
      for (const part of parts) {
        const times = frequency(one.parts[part], word);
        if (times === 0) continue;
        const length = one.parts[part].length / Math.max(1, average[part]);
        score +=
          (rarity.get(word) ?? 0) *
          SEARCH_WEIGHTS[part] *
          ((times * (BM25_K1 + 1)) / (times + BM25_K1 * (1 - BM25_B + BM25_B * length)));
      }
    }
    return { tool: one.tool, score: named(one.tool) ? Number.POSITIVE_INFINITY : score };
  });
  // A tool named by the query stays whatever the cutoff; the others are measured against the best of them.
  const best = Math.max(0, ...scored.map((one) => one.score).filter(Number.isFinite));
  return scored
    .filter((one) => one.score > 0 && one.score >= best * SEARCH_CUTOFF)
    .toSorted((a, b) => b.score - a.score || a.tool.js.localeCompare(b.tool.js))
    .slice(0, limit)
    .map((one) => foundOf(one.tool));
}

/** What a tool's result is to the script that called it: parsed when it is JSON, its text otherwise. */
function valueOfText(text: string): unknown {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not JSON after all.
    }
  }
  return text;
}

/**
 * What one of the agent's tools returned, as the script that called it is given it: text
 * parsed when it is JSON, and anything else part by part. An image in base64 is in the shape
 * `image()` takes.
 */
export function valueOfTool(value: Json): unknown {
  if (typeof value === 'string') return valueOfText(value);
  const parts = contentPartSchema.array().safeParse(value);
  if (!parts.success) return value;
  if (parts.data.every((part) => part.type === 'text')) {
    return valueOfText(
      parts.data.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
    );
  }
  return parts.data.map((part) =>
    part.type === 'image' && part.source.type === 'base64'
      ? { type: 'image', data: part.source.data, mimeType: part.source.mediaType }
      : part,
  );
}

/** What a server's answer is to the script that called it. */
export function valueOfMcp(result: McpResult): CodemodeOutcome {
  const texts = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');
  if (result.isError === true) {
    return { ok: false, message: texts.join('\n') || 'The tool failed, and did not say why' };
  }
  if (result.structuredContent !== undefined) return { ok: true, value: result.structuredContent };
  // Text alone is the text. Anything else is given as the server sent it.
  if (texts.length === result.content.length) {
    return { ok: true, value: valueOfText(texts.join('\n')) };
  }
  return { ok: true, value: result.content };
}

/**
 * The first and the last of a text that is too long, with what was left out between them said,
 * and `how` to see all of it.
 */
export function cutMiddle(
  text: string,
  most: number,
  how = 'Return less to see all of it',
): string {
  if (text.length <= most) return text;
  const half = Math.floor(most / 2);
  const left = text.length - 2 * half;
  return `${text.slice(0, half)}\n[… ${left.toLocaleString('en-US')} characters left out of the middle. ${how} …]\n${text.slice(-half)}`;
}

/**
 * What a script printed, and what it gave back beside what it returned, in the order it did.
 * With `shown`, the images it gave with `image()` that the model is shown, each in its place as
 * its mark; without, each is named.
 */
function printedOf(
  result: CodemodeResult,
  shown?: ImagePart[],
): { readonly given: string[]; readonly logged: string[] } {
  const given: string[] = [];
  const logged: string[] = [];
  // Its text is the script's: nothing in it is taken for an image's place.
  const own = (text: string): string => (shown === undefined ? text : unmarked(text));
  for (const item of result.output) {
    // What it wrote with `text()` is part of what it gives back, before what it returns.
    if (item.type === 'text' && item.console !== true) given.push(own(item.text));
    if (item.type === 'text' && item.console === true) logged.push(own(item.text));
    if (item.type !== 'image') continue;
    if (shown === undefined) {
      given.push('[image]');
      continue;
    }
    // Base64 is 4 characters for each 3 bytes.
    const bytes = Math.floor((item.data.length * 3) / 4);
    if (bytes > IMAGE_BYTES) {
      given.push(
        `[an image of ${megabytes(bytes)} left out: an image is at most ${megabytes(IMAGE_BYTES)}]`,
      );
    } else if (shown.length >= TASK_IMAGES) {
      given.push(`[an image left out: a script shows at most ${String(TASK_IMAGES)}]`);
    } else {
      given.push(imageMark(shown.length));
      shown.push({
        type: 'image',
        source: { type: 'base64', mediaType: item.mimeType, data: item.data },
      });
    }
  }
  return { given, logged };
}

/** How a script that did not return ended, in the lines the model reads. */
function failureOf(result: CodemodeResult): string[] {
  if (result.ok) return [];
  if (result.error.kind === 'script') {
    return [
      result.error.stack ?? `${result.error.name ?? 'Error'}: ${result.error.message}`,
      '[failed]',
    ];
  }
  if (result.error.kind === 'sandbox') {
    return [`The script could not be run: ${result.error.message}`, '[failed]'];
  }
  return [];
}

type Ended = {
  readonly result: CodemodeResult;
  /** Lines the engine adds: such as how far a stopped script got. */
  readonly notes?: readonly string[];
};

/**
 * How a script's ending reads: what it returned, what it logged, and what went wrong. With the
 * script's ID, one that is too long to show whole says how a later script reads all of it.
 */
export function renderScript(ended: Ended, most: number, id?: string): string {
  const { result, notes = [] } = ended;
  const { given, logged } = printedOf(result, []);
  const parts: string[] = [...given];
  const returned = result.ok && result.value !== undefined;
  if (returned) {
    parts.push(
      unmarked(
        typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2),
      ),
    );
  }
  if (logged.length > 0) parts.push(`[console]\n${logged.join('\n')}`);
  parts.push(...[...failureOf(result), ...notes].map(unmarked));
  if (parts.length === 0) return '(nothing returned)';
  const rest = parts.length - (returned ? 1 : 0) > 0;
  const how =
    id === undefined
      ? undefined
      : `A script can read all of it: ${[
          ...(returned ? [`${READ_RESULT}("${id}")${rest ? ' for what it returned' : ''}`] : []),
          ...(rest ? [`${READ_LOGS}("${id}")${returned ? ' for the rest' : ''}`] : []),
        ].join(', ')}`;
  return cutMiddle(parts.join('\n'), most, how);
}

/** The images a script's ending shows the model, in the order of their marks in `renderScript`. */
export function scriptImages(result: CodemodeResult): ImagePart[] {
  const shown: ImagePart[] = [];
  printedOf(result, shown);
  return shown;
}

/**
 * All of what a script came to, as it is kept for a later script: what it returned, as data,
 * and everything else it would be shown of it, as text.
 */
export function keptOf(ended: Ended): ScriptKept {
  const { result, notes = [] } = ended;
  const { given, logged } = printedOf(result);
  let how: ScriptKept['ended'] = 'returned';
  if (!result.ok) {
    how = result.error.kind === 'script' || result.error.kind === 'sandbox' ? 'failed' : 'stopped';
  }
  return {
    ended: how,
    value: result.ok && result.value !== undefined ? JSON.stringify(result.value) : null,
    logs: [...given, ...logged, ...failureOf(result), ...notes].join('\n'),
  };
}

/** What is wrong with a script that does not parse, or undefined. */
export function syntaxProblem(script: string): string | undefined {
  try {
    // Compiled, never run: as the body of an async function, which is what a script is.
    // eslint-disable-next-line no-new
    new Script(`(async function () {\n${script}\n})`, { filename: 'script.js', lineOffset: -1 });
    return undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const line = /script\.js:(\d+)/.exec(error.stack ?? '')?.[1];
    return `${error.message}${line === undefined ? '' : `, on line ${line}`}`;
  }
}

type Input = { readonly script: string; readonly timeout: number };

/**
 * Whether an agent has code mode at all: a tool of its own set to code mode, or an MCP server.
 * An agent with neither has nothing for a script to call, so its model is not offered `code`,
 * and is told nothing about scripts. This is the one rule for both: whatever else is said to a
 * model about code mode asks here first.
 */
export const hasCodeMode = (definition: AgentDefinition): boolean =>
  scriptToolsOf(definition).length > 0 || (definition.mcps ?? []).length > 0;

/** The `code` tool's description for an agent: what there is for a script to call. */
export function describeCode(definition: AgentDefinition): string {
  const own = scriptToolsOf(definition);
  const servers = definition.mcps ?? [];
  // How a script works is in the model's instructions (see `scaffold.ts`). Here is what there is to call.
  const lines = [
    'Runs a script: JavaScript that calls your tools, as the body of an async function, and answers with what it returns.',
  ];
  if (own.length > 0) {
    lines.push(
      '',
      'Your tools:',
      '```ts',
      renderDeclarations({
        tools: own.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as CodemodeJsonSchema,
          execute: () => undefined,
        })),
      }),
      '```',
    );
  }
  if (servers.length > 0) {
    lines.push(
      '',
      'MCP servers, whose tools are not listed here:',
      ...servers.map(
        (server) =>
          `- ${server.name}${server.description === undefined ? '' : `: ${server.description}`}`,
      ),
      'A tool of a server is `tools.mcp__<server>__<tool>`. `searchTools(query, { limit, server })` gives the best matches inside a script, each with its `name`, `description` and `signature`.',
    );
  }
  return lines.join('\n');
}

export type CodeOptions = {
  readonly store: Store;
  /** An actor by its ID. A task may outlive the turn that started it, and the engine that did. */
  readonly actorOf: (actor: ActorId) => Promise<Actor | undefined>;
  /** What the code an actor is on says the agent is. */
  readonly definitionOf: (actor: Actor) => Promise<AgentDefinition>;
  /** Calls a function of the code an actor is on. */
  readonly call: (
    actor: Actor,
    path: string,
    argument: Json,
    signal: AbortSignal,
  ) => Promise<CallResult>;
  /** The agent's MCP servers, as the engine reaches them. */
  readonly mcp: Mcp;
  readonly clock?: () => number;
  readonly report?: (error: unknown) => void;
};

const cutOff = (name: string): CodemodeOutcome => ({
  ok: false,
  message: `The call of ${name} was cut off when the engine stopped. It may or may not have run.`,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function codeKind(options: CodeOptions): TaskKind {
  const { store, actorOf, definitionOf, mcp } = options;
  const clock = options.clock ?? Date.now;
  const report =
    options.report ??
    ((error: unknown) => {
      console.error(error);
    });
  let sandbox: CodemodeSandbox | undefined;

  return {
    kind: 'code',
    prefix: 's',
    tool: {
      name: 'code',
      description: 'Runs JavaScript that calls your tools.',
      properties: {
        script: { type: 'string', description: 'JavaScript: the body of an async function.' },
      },
      required: ['script'],
    },
    timesOut: true,

    // Only where there is something for a script to call.
    available: (_actor, definition) => definition !== undefined && hasCodeMode(definition),
    describe: (_actor, definition) =>
      definition === undefined
        ? 'Runs JavaScript that calls your tools.'
        : describeCode(definition),

    input(args: JsonObject, _actor, limits): Json {
      const { script, ...rest } = args;
      if (typeof script !== 'string' || script.trim() === '') {
        throw new Error('script is JavaScript, and is not empty');
      }
      const unknown = Object.keys(rest)[0];
      if (unknown !== undefined) throw new Error(`${unknown} is not known`);
      const problem = syntaxProblem(script);
      if (problem !== undefined) throw new Error(`the script does not parse: ${problem}`);
      const input: Input = { script, timeout: limits.timeout ?? SCRIPT_TIMEOUT_S };
      return input;
    },

    title(input: Json): string {
      const lines = (input as Input).script.split('\n').filter((line) => line.trim() !== '');
      const first = (lines[0] ?? '').trim();
      return `${first.slice(0, 80)}${first.length > 80 || lines.length > 1 ? ' …' : ''}`;
    },

    async close(): Promise<void> {
      await sandbox?.close();
    },

    async run(task, { stop, closing }): Promise<TaskEnd> {
      const input = task.input as Input;
      const actor = await actorOf(task.actor);
      if (actor === undefined) return { status: 'lost', text: 'Its actor is gone' };
      // What it is run with: stored the first time, read every time after.
      let script = await store.loadScript(actor.id, task.id);
      if (script === undefined) {
        const definition = await definitionOf(actor);
        // What its servers offer is asked for now, and is what it has for as long as it runs.
        const servers = await mcp.catalog(actor, definition.mcps ?? []);
        if (closing.aborted) return { status: 'lost', text: '' };
        script = await store.startScript(actor.id, task.id, {
          startedAt: clock(),
          seed: randomInt(0, 2 ** 32),
          catalog: {
            tools: scriptTools(definition, servers),
            down: servers.down,
          } satisfies Catalog as unknown as Json,
        });
      }
      if (closing.aborted) return { status: 'lost', text: '' };
      const catalog = script.catalog as unknown as Catalog;
      const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));

      /**
       * What is stored of a call's result. What a script read of an earlier one is kept once,
       * with that one: here it is only said which it was. A script that has ended does not
       * change, so it reads the same again.
       */
      const storedOf = (call: ScriptCall | undefined, outcome: CodemodeOutcome): Json => {
        const reads = call !== undefined && (call.name === READ_RESULT || call.name === READ_LOGS);
        return (
          reads && outcome.ok ? { ok: true, from: JSON.parse(call.args) as Json } : outcome
        ) as Json;
      };

      /** A call's result as it was, from what is stored of it. */
      const outcomeOf = async (call: ScriptCall): Promise<CodemodeOutcome> => {
        const stored = (call.done?.outcome ?? null) as unknown as CodemodeOutcome & {
          readonly from?: string;
        };
        if (stored.from === undefined) return stored;
        const kept = (await store.loadScript(actor.id, stored.from))?.kept ?? null;
        if (kept === null) {
          return { ok: false, message: `What the script ${stored.from} came to is no longer kept` };
        }
        return {
          ok: true,
          value:
            call.name === READ_LOGS
              ? kept.logs
              : kept.value === null
                ? null
                : (JSON.parse(kept.value) as unknown),
        };
      };

      const rows = new Map<number, ScriptCall>(
        (await store.listScriptCalls(actor.id, task.id)).map((call) => [call.id, call]),
      );
      /** Results that are stored and that the machine has not been handed yet, by their place. */
      const waiting = new Map<number, { id: number; at: number; outcome: CodemodeOutcome }>();
      let lastSeq = 0;
      for (const row of rows.values()) {
        if (row.done === null) continue;
        lastSeq = Math.max(lastSeq, row.done.seq);
        waiting.set(row.done.seq, { id: row.id, at: row.done.at, outcome: await outcomeOf(row) });
      }
      if (closing.aborted) return { status: 'lost', text: '' };
      let nextSeq = 1;
      const issued = new Set<number>();
      /** Why the script cannot be continued, once that is so. */
      let diverged: string | undefined;

      const abort = new AbortController();
      const give = (): void => {
        abort.abort();
      };
      stop.addEventListener('abort', give, { once: true });
      closing.addEventListener('abort', give, { once: true });
      if (stop.aborted || closing.aborted) give();

      let active = 0;
      const queued: (() => void)[] = [];
      /** Runs `work` once fewer than `AT_ONCE` calls of this script are under way. */
      const inTurn = async <T>(work: () => Promise<T>): Promise<T> => {
        if (active >= AT_ONCE) {
          await new Promise<void>((resolve) => {
            queued.push(resolve);
          });
        }
        active += 1;
        try {
          return await work();
        } finally {
          active -= 1;
          queued.shift()?.();
        }
      };

      // What is stored of the script is stored in the order it happened: one thing at a time.
      let journal: Promise<void> = Promise.resolve();
      const inOrder = (work: () => Promise<void>): void => {
        journal = journal.then(work).catch((error: unknown) => {
          if (closing.aborted) return;
          report(error);
          diverged ??= 'the engine failed on one of its calls';
          give();
        });
      };

      // eslint-disable-next-line prefer-const
      let run: CodemodeRun;

      /** Hands the machine every stored result it is ready for, in their order. */
      const hand = (): void => {
        for (;;) {
          const next = waiting.get(nextSeq);
          if (next === undefined || !issued.has(next.id) || run.finished) return;
          waiting.delete(nextSeq);
          try {
            run.deliver(nextSeq, next.at, next.id, next.outcome);
          } catch (error) {
            diverged = `it could not be handed a result it had before: ${messageOf(error)}`;
            give();
            return;
          }
          nextSeq += 1;
        }
      };

      /** Stores a call's result with its place, and hands it on. */
      const finish = async (id: number, outcome: CodemodeOutcome): Promise<void> => {
        // A result that arrives as the engine goes away is not stored: the call is seen as cut off.
        if (closing.aborted) return;
        const at = clock();
        lastSeq += 1;
        const seq = lastSeq;
        const done = { seq, at, outcome: storedOf(rows.get(id), outcome) };
        await store.finishScriptCall(actor.id, task.id, id, done);
        const row = rows.get(id);
        if (row !== undefined) rows.set(id, { ...row, done });
        waiting.set(seq, { id, at, outcome });
        hand();
      };

      /**
       * What an earlier script of this actor came to: what it returned, as the data it was, or
       * what it printed. Only once it has ended, so that what is read is what it is for good.
       */
      const read = async (what: string, wanted: unknown): Promise<CodemodeOutcome> => {
        if (typeof wanted !== 'string' || wanted === '') {
          return { ok: false, message: `${what} takes the ID of a script, such as "s3"` };
        }
        if (wanted === task.id) return { ok: false, message: `${wanted} is this script` };
        const other = await store.loadTask(actor.id, wanted);
        if (other === undefined) return { ok: false, message: `You have no script ${wanted}` };
        if (other.kind !== 'code') {
          return { ok: false, message: `${wanted} is not a script: it is a ${other.kind} task` };
        }
        if (other.status === 'running') {
          return {
            ok: false,
            message: `The script ${wanted} is still running: it can be read once it has ended`,
          };
        }
        const kept = (await store.loadScript(actor.id, wanted))?.kept ?? null;
        if (kept === null) {
          return { ok: false, message: `What the script ${wanted} came to was not kept` };
        }
        if (what === READ_LOGS) return { ok: true, value: kept.logs };
        if (kept.ended === 'returned') {
          return {
            ok: true,
            value: kept.value === null ? null : (JSON.parse(kept.value) as unknown),
          };
        }
        return {
          ok: false,
          message: `The script ${wanted} ${kept.ended === 'failed' ? 'failed' : 'was stopped'}, so it returned nothing. What it printed, and how it ended: ${READ_LOGS}("${wanted}")`,
        };
      };

      /** Makes a call, and resolves with what the script is told of it. Never rejects. */
      const answer = async (
        call: CodemodeHostCall,
        startedAt: number,
      ): Promise<CodemodeOutcome> => {
        try {
          if (call.target === 'global') {
            if (call.name === 'searchTools') {
              const [query, narrowed] = (Array.isArray(call.args) ? call.args : []) as [
                unknown,
                unknown,
              ];
              if (typeof query !== 'string') {
                return { ok: false, message: 'searchTools takes a query, as text' };
              }
              const { limit, server } = (narrowed ?? {}) as { limit?: unknown; server?: unknown };
              return {
                ok: true,
                value: searchTools(catalog.tools, query, {
                  ...(typeof limit === 'number' ? { limit } : {}),
                  ...(typeof server === 'string' ? { server } : {}),
                }),
              };
            }
            if (call.name === 'describeTool') {
              const wanted = String(call.args).replace(/^tools\./, '');
              const tool = catalog.tools.find((one) => one.js === wanted || one.name === wanted);
              return { ok: true, value: tool === undefined ? null : foundOf(tool) };
            }
            if (call.name === 'sleep') {
              const seconds = Number(call.args);
              if (!(seconds >= 0)) {
                return { ok: false, message: 'sleep takes a number of seconds, 0 or more' };
              }
              // Counted from when it was first asked for, which may have been before a restart.
              const left = startedAt + seconds * 1000 - clock();
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.min(Math.max(left, 0), LONGEST_TIMER_MS));
                abort.signal.addEventListener(
                  'abort',
                  () => {
                    clearTimeout(timer);
                    resolve();
                  },
                  { once: true },
                );
              });
              return { ok: true, value: null };
            }
            if (call.name === READ_RESULT || call.name === READ_LOGS) {
              return await read(call.name, call.args);
            }
            return { ok: false, message: `There is no ${call.name}` };
          }

          const tool = tools.get(call.name);
          if (tool === undefined) return { ok: false, message: `There is no tool ${call.name}` };
          const args = (call.args ?? {}) as Json;
          if (tool.server !== undefined && tool.tool !== undefined) {
            const servers = (await definitionOf(actor)).mcps ?? [];
            const server = servers.find((one) => one.name === tool.server);
            if (server === undefined) {
              return {
                ok: false,
                message: `The agent no longer has the MCP server ${tool.server}`,
              };
            }
            try {
              return valueOfMcp(await mcp.call(actor, server, tool.tool, args, abort.signal));
            } catch (error) {
              return {
                ok: false,
                message: `The call of ${tool.js} did not go through: ${messageOf(error)}`,
              };
            }
          }
          const make = () => options.call(actor, `tools.${tool.name}.execute`, args, abort.signal);
          let result = await make();
          // What ran the tool died with the call in it: it may or may not have run. One that is
          // safe to make again is made again, once.
          if (!result.ok && result.kind === 'lost' && tool.retrySafe && !abort.signal.aborted) {
            result = await make();
          }
          if (result.ok) return { ok: true, value: valueOfTool(result.value) };
          if (result.kind === 'lost') {
            return {
              ok: false,
              message: `The call of ${tool.js} was lost: ${result.reason}. It may or may not have run.`,
            };
          }
          if (result.kind === 'invalid') {
            return {
              ok: false,
              message: `The arguments of ${tool.js} are not valid: ${issuesText(result.issues)}`,
            };
          }
          return { ok: false, message: result.error.message };
        } catch (error) {
          return { ok: false, message: messageOf(error) };
        }
      };

      const make = (call: CodemodeHostCall, startedAt: number): void => {
        void inTurn(() => answer(call, startedAt)).then((outcome) => {
          // A script that was stopped is told nothing more.
          if (abort.signal.aborted) return;
          inOrder(() => finish(call.id, outcome));
        });
      };

      /** The script made a call: one it made before, or a new one. */
      const called = async (call: CodemodeHostCall): Promise<void> => {
        issued.add(call.id);
        const args = JSON.stringify(call.args ?? null);
        const before = rows.get(call.id);
        if (before !== undefined) {
          if (before.name !== call.name || before.args !== args) {
            diverged = `its call number ${String(call.id)} was ${before.name} before, and is ${call.name} now`;
            give();
            return;
          }
          if (before.done !== null) {
            hand();
            return;
          }
          // It was under way when the engine stopped.
          if (before.retrySafe) make(call, before.startedAt);
          else await finish(call.id, cutOff(call.name));
          return;
        }
        const retrySafe = call.target === 'global' || tools.get(call.name)?.retrySafe === true;
        const row: ScriptCall = {
          id: call.id,
          name: call.name,
          args,
          retrySafe,
          startedAt: clock(),
          done: null,
        };
        // Stored before it is made.
        await store.addScriptCall(actor.id, task.id, row);
        rows.set(call.id, row);
        if (call.id > SCRIPT_CALLS) {
          await finish(call.id, {
            ok: false,
            message: `A script may make ${SCRIPT_CALLS.toLocaleString('en-US')} calls, and this one has`,
          });
          return;
        }
        if (closing.aborted) return;
        make(call, row.startedAt);
      };

      sandbox ??= new CodemodeSandbox({ memoryLimitBytes: MEMORY_BYTES });
      // Its time counts from when the task started, whatever happened to the engine since.
      const left = task.startedAt + input.timeout * 1000 - clock();
      run = sandbox.start(input.script, {
        startedAt: script.startedAt,
        seed: script.seed,
        tools: catalog.tools.map((tool) => ({
          name: tool.name,
          jsName: tool.js,
          description: tool.description,
        })),
        globals: [
          { name: 'searchTools', spread: true },
          { name: 'describeTool' },
          { name: 'sleep' },
          { name: READ_RESULT },
          { name: READ_LOGS },
        ],
        signal: abort.signal,
        timeoutMs: Math.max(1, left),
        onCall: (call) => {
          // Not from inside the machine's own step, and after what was stored before it.
          inOrder(() => called(call));
        },
      });

      let result: CodemodeResult;
      try {
        result = await run.result;
        // Everything it did is stored before it is said to have ended.
        for (let last: Promise<void> | undefined; last !== journal;) {
          last = journal;
          await last;
        }
      } finally {
        stop.removeEventListener('abort', give);
        closing.removeEventListener('abort', give);
      }
      // The engine is going away: the script is run again by the next one.
      if (closing.aborted) return { status: 'lost', text: '' };

      if (diverged !== undefined) {
        const text = `The script could not be continued after the engine restarted: ${diverged}. Some of its calls were made: check before running it again.\n[failed]`;
        await store.endScript(actor.id, task.id, { ended: 'failed', value: null, logs: text });
        return { status: 'failed', text };
      }

      const notes: string[] = [];
      const calls = [...rows.values()].filter((row) => !OWN_CALLS.includes(row.name));
      const finished = calls.filter((row) => row.done !== null).length;
      if (!result.ok && (result.error.kind === 'aborted' || result.error.kind === 'timeout')) {
        // What it had under way may still be done where it was sent.
        const underWay = calls.length - finished;
        if (calls.length > 0) {
          notes.push(
            `[stopped part way: ${String(finished)} of its ${String(calls.length)} calls had finished${
              underWay > 0 ? `, and ${String(underWay)} were under way and may still be done` : ''
            }]`,
          );
        }
      }
      if (!result.ok && result.error.kind === 'script') {
        // It may have failed for a tool of a server that was away when it started.
        const { message } = result.error;
        notes.push(
          ...catalog.down
            .filter((one) => message.includes(`mcp__${safe(one.server)}__`))
            .map(
              (one) =>
                `Note: the MCP server ${one.server} could not be reached when the script started, so its tools were not there (${one.reason}).`,
            ),
        );
      }
      // Kept before the task is said to have ended: once it has, a later script may ask for it.
      await store.endScript(actor.id, task.id, keptOf({ result, notes }));
      const render = (most: number): string => renderScript({ result, notes }, most, task.id);
      const images = scriptImages(result);
      const rendered = {
        text: render(Number.MAX_SAFE_INTEGER),
        render,
        ...(images.length === 0 ? {} : { images }),
      };
      if (result.ok) return { status: 'done', ...rendered };
      switch (result.error.kind) {
        case 'script':
        case 'sandbox':
          return { status: 'failed', ...rendered };
        case 'timeout':
          return { status: 'done', stoppedBy: 'timeout', ...rendered };
        default:
          return { status: 'done', ...rendered };
      }
    },
  };
}
