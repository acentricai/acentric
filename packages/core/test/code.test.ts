// What a script is made of, apart from running one: the tools it can call and how it finds
// them, how its ending reads, what is kept of it, and what a model is told of scripts.

import { describe, expect, it } from 'vitest';

import type { AgentDefinition, Json } from '@acentric/protocol';

import {
  cutMiddle,
  describeCode,
  hasCodeMode,
  keptOf,
  renderScript,
  scriptTools,
  searchTools,
  syntaxProblem,
  valueOfMcp,
  valueOfTool,
} from '../src/code.ts';
import type { McpCatalog } from '../src/mcp.ts';
import { scaffoldOf } from '../src/scaffold.ts';

type Declared = AgentDefinition['tools'][number];

const tool = (name: string, description: string, more: Partial<Declared> = {}): Declared => ({
  name,
  description,
  parameters: { type: 'object' },
  retrySafe: false,
  codemode: true,
  ...more,
});
const agent = (...tools: Declared[]): AgentDefinition => ({
  provider: 'fake',
  instructions: '',
  configuration: null,
  tools,
  inputs: [],
});
/** A tool of a server, as the server lists it. */
const served = (
  server: string,
  name: string,
  description: string,
  more: Partial<McpCatalog['tools'][number]> = {},
): McpCatalog['tools'][number] => ({ server, name, description, retrySafe: false, ...more });
const object = (properties: { readonly [key: string]: Json }): Declared['parameters'] => ({
  type: 'object',
  properties,
});

describe('an agent with code mode', () => {
  it('is one with a tool set to code mode, and is told of what it has', () => {
    const direct = tool('a_tool', 'Does a thing.', { codemode: false });
    const { codemode: _left, ...unsaid } = direct;
    expect(hasCodeMode(agent())).toBe(false);
    expect(hasCodeMode(agent(direct, unsaid))).toBe(false);
    expect(hasCodeMode(agent(direct, tool('in_scripts', 'For scripts.')))).toBe(true);

    const told = describeCode(agent(direct, tool('in_scripts', 'For scripts.')));
    expect(told).toContain('Your tools:\n```ts\ndeclare const tools: {');
    expect(told).toMatch(/\/\*\* For scripts\. \*\/\s+in_scripts\(args:/);
    expect(told).not.toContain('a_tool');
    // What is told of code mode is of what the agent has, and no more.
    expect(told).not.toMatch(/MCP|searchTools|ALL_TOOLS/);
  });

  it('is one with an MCP server too, with or without a tool of its own for scripts', () => {
    const direct = tool('a_tool', 'Does a thing.', { codemode: false });
    const withServers: AgentDefinition = {
      ...agent(direct),
      mcps: [
        { name: 'docs', url: 'https://example.com/mcp' },
        { name: 'wiki', url: 'https://example.com/wiki', description: 'What the team wrote.' },
      ],
    };
    expect(hasCodeMode(withServers)).toBe(true);
    const told = describeCode(withServers);
    expect(told).toContain('- docs\n- wiki: What the team wrote.\n');
    expect(told).toContain('searchTools');
    expect(told).not.toMatch(/Your tools:|a_tool/);
    expect(hasCodeMode({ ...agent(direct), mcps: [] })).toBe(false);
  });

  it('has its model told how a script works, by whether it has a machine too', () => {
    const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('# '));
    const alone = scaffoldOf({ tools: ['code', 'schedule', 'stop'], machine: null });
    expect(headings(alone)).toEqual(['# How you work here', '# Tasks', '# Scripts']);
    expect(alone).toContain('# Tasks\n\nA script is a task.');
    expect(alone).toContain('- `wait: 0` starts a task without waiting: for long work');
    expect(alone).toContain('\n\nA script has no files, no shell, no network and no imports');
    expect(alone).toContain('`image(x)` shows you an image there');
    expect(alone).toContain('At most 5 a script.');

    const machine = { cwd: '~/work', os: 'linux', arch: 'x64' };
    const both = scaffoldOf({ tools: ['bash', 'code', 'schedule', 'stop'], machine });
    expect(headings(both)).toEqual([
      '# How you work here',
      '# Tasks',
      '# Your machine',
      '# Scripts',
    ]);
    expect(both).toContain('# Tasks\n\nA command or a script is a task.');
    expect(both).toContain('- `wait: 0` starts a task without waiting: for a server, or for long');
    expect(both).toContain('A script does not run on your machine. It has no files');

    // Without it, nothing is said of scripts.
    const commands = scaffoldOf({ tools: ['bash', 'schedule', 'stop'], machine });
    expect(commands).toContain('# Tasks\n\nA command is a task.');
    expect(commands).not.toMatch(/JavaScript|# Scripts|`code`/);
  });
});

describe('what a script is made of', () => {
  it('names every tool so that a script can say it, and no two the same', () => {
    const tools = scriptTools(
      agent(
        tool('send-mail', 'Sends mail.'),
        tool('hidden', 'Not for scripts.', { codemode: false }),
        tool('send_mail', 'Sends mail, the other way.', { retrySafe: true }),
        tool('lookup', 'Looks an order up.', { parameters: object({ id: { type: 'string' } }) }),
      ),
    );
    expect(tools.map((one) => one.js)).toEqual(['send_mail', 'send_mail_2', 'lookup']);
    // What the agent calls it is kept for the call.
    expect(tools[0]).toMatchObject({ name: 'send-mail', retrySafe: false });
    expect(tools[1]).toMatchObject({ name: 'send_mail', retrySafe: true });
    expect(tools[2]?.signature).toMatch(/^lookup\(args: \{[\s\S]*id\?: string;[\s\S]*\}\)/);
  });

  it('names a server’s tool by its server, with what the server calls it kept for the call', () => {
    const tools = scriptTools(agent(tool('send-mail', 'Sends mail.')), {
      tools: [
        served('my-server', 'do.it', 'Does it.', { retrySafe: true }),
        served('my-server', 'do_it', 'Does it, the other way.'),
        served('other', 'create_issue', 'Opens an issue in a repository.', {
          inputSchema: object({ title: { type: 'string' } }),
          outputSchema: object({ number: { type: 'number' } }),
        }),
      ],
      down: [],
    });
    expect(tools.map((one) => one.js)).toEqual([
      'send_mail',
      'mcp__my_server__do_it',
      'mcp__my_server__do_it_2',
      'mcp__other__create_issue',
    ]);
    expect(tools[1]).toMatchObject({ server: 'my-server', tool: 'do.it', retrySafe: true });
    expect(tools[2]).toMatchObject({ name: 'mcp__my_server__do_it_2', retrySafe: false });
    // What it takes and what it gives are in its declaration.
    expect(tools[3]?.signature).toMatch(
      /^mcp__other__create_issue\(args: \{[\s\S]*title\?: string;[\s\S]*\}\): Promise<\{[\s\S]*number\?: number;/,
    );
  });

  it('finds a server’s tools by its name, and among one server’s alone when asked', () => {
    const tools = scriptTools(agent(tool('send-mail', 'Sends mail.')), {
      tools: [
        served('wiki', 'read_contents', 'Reads the documentation of a repository.'),
        served('wiki', 'ask_question', 'Asks a question about a repository.'),
        served('tracker', 'create_issue', 'Opens an issue in a repository.'),
      ],
      down: [],
    });
    const names = (query: string, options = {}): string[] =>
      searchTools(tools, query, options).map((one) => one.name);
    expect(names('wiki').toSorted()).toEqual([
      'mcp__wiki__ask_question',
      'mcp__wiki__read_contents',
    ]);
    expect(names('', { server: 'wiki' })).toEqual([
      'mcp__wiki__ask_question',
      'mcp__wiki__read_contents',
    ]);
    expect(names('repository', { server: 'tracker' })).toEqual(['mcp__tracker__create_issue']);
    expect(names('issue', { server: 'wiki' })).toEqual([]);
    // A tool's own name gives it first.
    expect(names('mcp__wiki__ask_question')[0]).toBe('mcp__wiki__ask_question');
  });

  it('gives a script a server’s answer as what it is', () => {
    const text = (value: string) => ({ type: 'text', text: value });
    expect(valueOfMcp({ content: [text('{"a": 1}')] })).toEqual({ ok: true, value: { a: 1 } });
    expect(valueOfMcp({ content: [text('[1, 2]')] })).toEqual({ ok: true, value: [1, 2] });
    expect(valueOfMcp({ content: [text('{not json')] })).toEqual({ ok: true, value: '{not json' });
    expect(valueOfMcp({ content: [text('12')] })).toEqual({ ok: true, value: '12' });
    expect(valueOfMcp({ content: [text('a'), text('b')] })).toEqual({ ok: true, value: 'a\nb' });
    expect(valueOfMcp({ content: [text('ignored')], structuredContent: { b: 2 } })).toEqual({
      ok: true,
      value: { b: 2 },
    });
    expect(valueOfMcp({ content: [text('no'), text('really')], isError: true })).toEqual({
      ok: false,
      message: 'no\nreally',
    });
    expect(valueOfMcp({ content: [], isError: true })).toEqual({
      ok: false,
      message: 'The tool failed, and did not say why',
    });
    const mixed = [text('a'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }];
    expect(valueOfMcp({ content: mixed })).toEqual({ ok: true, value: mixed });
  });

  it('finds tools by the words of their names first, then of their descriptions', () => {
    const tools = scriptTools(
      agent(
        tool('send-mail', 'Sends mail.'),
        tool('create_issue', 'Opens an issue in a repository.'),
        tool('list_issues', 'Lists the issues of a repository.'),
        tool('close', 'Closes an issue.'),
      ),
    );
    const names = (query: string, options = {}): string[] =>
      searchTools(tools, query, options).map((one) => one.name);
    expect(names('issue')).toEqual(['create_issue', 'list_issues', 'close']);
    expect(names('create an issue')[0]).toBe('create_issue');
    expect(names('mail')).toEqual(['send_mail']);
    expect(names('nothing like this')).toEqual([]);
    expect(names('issue', { limit: 2 })).toHaveLength(2);
    // Nothing to look for: every tool, by name.
    expect(names('')).toEqual(['close', 'create_issue', 'list_issues', 'send_mail']);
  });

  it('ranks by BM25: small words dropped, other forms the same, rare words first, parameters searched', () => {
    const tools = scriptTools(
      agent(
        tool('ask_question', 'Asks a question about a GitHub repository, and answers it.', {
          parameters: object({
            repoName: { type: 'string', description: 'The repository' },
            question: { type: 'string' },
          }),
        }),
        tool('read_contents', 'Reads the documentation of a GitHub repository.'),
        tool('read_structure', 'Lists the documentation topics of a GitHub repository.'),
        tool('createTicket', 'Opens a new one.', {
          parameters: object({
            title: { type: 'string' },
            priority: { type: 'string', description: 'How urgent it is' },
          }),
        }),
        tool('update_record', 'Changes a record.', {
          parameters: object({ record_id: { type: 'string' }, severity: { type: 'string' } }),
        }),
        tool('city_population', 'The population of a city, from a small table.'),
        tool('archive', 'Moves old notes away.'),
        tool('tidy', 'Archives notes, archives drafts, and archives the rest.'),
        tool('use_it', 'Uses it.'),
        tool('read', 'Gives one back.'),
      ),
    );
    const names = (query: string): string[] => searchTools(tools, query).map((one) => one.name);

    // "a" is in nearly every description, and is not looked for.
    expect(names('create a ticket')).toEqual(['createTicket']);
    // A name is split where its case changes.
    expect(names('ticket')).toEqual(['createTicket']);
    // Other forms of a word are the word.
    expect(names('creating tickets')).toEqual(['createTicket']);
    // Parameters, their names and what they are for.
    expect(names('severity')).toEqual(['update_record']);
    expect(names('urgent')).toEqual(['createTicket']);
    // The word few tools have decides: all three say repository, two say documentation.
    expect(names('repository documentation')).toEqual([
      'read_contents',
      'read_structure',
      'ask_question',
    ]);
    // Of words in the same place, the rare one decides: "topics" is in one tool, "repository" in three.
    expect(names('repository topics')[0]).toBe('read_structure');
    // A word in a name counts more than the same word three times in a description.
    expect(names('archive')).toEqual(['archive', 'tidy']);
    // A match far weaker than the best is none: the other two only say repository.
    expect(names('question repository')).toEqual(['ask_question']);
    // A word is found at the start of a longer one.
    expect(names('doc')).toEqual(['read_contents', 'read_structure']);
    // A tool's own name gives it first, even a name of small words alone.
    expect(names('use_it')[0]).toBe('use_it');
    // read_contents says read in its name and its description, but `read` is the tool named.
    expect(names('read')).toEqual(['read', 'read_contents', 'read_structure']);
    // Nothing to look for: every tool, as many as the limit.
    expect(names('a the of')).toHaveLength(8);
    expect(names('volcano')).toEqual([]);
  });

  it('gives a script what a tool returned as what it is', () => {
    const text = (value: string) => ({ type: 'text', text: value });
    expect(valueOfTool('{"a": 1}')).toEqual({ a: 1 });
    expect(valueOfTool('[1, 2]')).toEqual([1, 2]);
    expect(valueOfTool('{not json')).toBe('{not json');
    expect(valueOfTool('12')).toBe('12');
    expect(valueOfTool([text('{"a":'), text('1}')])).toEqual({ a: 1 });
    expect(valueOfTool([text('a'), text('b')])).toBe('a\nb');
    // An image is in the shape `image()` takes.
    expect(
      valueOfTool([
        text('a'),
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
      ]),
    ).toEqual([text('a'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  });

  it('cuts the middle out of what is too long, and says how much', () => {
    expect(cutMiddle('short', 10)).toBe('short');
    expect(cutMiddle('abcdefghij'.repeat(10), 20)).toBe(
      'abcdefghij\n[… 80 characters left out of the middle. Return less to see all of it …]\nabcdefghij',
    );
  });

  it('says where a script does not parse', () => {
    expect(syntaxProblem('const a = await tools.x({});\nreturn a;')).toBeUndefined();
    expect(syntaxProblem('return (1 + ;')).toBe("Unexpected token ';', on line 1");
    expect(syntaxProblem('const a = 1;\n\nfunction {')).toMatch(/, on line 3$/);
  });
});

describe('how a script’s ending reads', () => {
  const logged = (text: string) => ({ type: 'text', text, console: true });

  it('says how to read all of it by what there is to read', () => {
    const long = 'z'.repeat(300);
    const marker = (result: object): string =>
      /\[… .*? …\]/.exec(renderScript({ result: result as never }, 100, 's4'))?.[0] ?? '(not cut)';
    expect(marker({ ok: true, value: long, output: [] })).toBe(
      '[… 200 characters left out of the middle. A script can read all of it: resultOf("s4") …]',
    );
    expect(marker({ ok: true, value: long, output: [logged('a line')] })).toContain(
      'A script can read all of it: resultOf("s4") for what it returned, logsOf("s4") for the rest …]',
    );
    expect(marker({ ok: true, output: [logged(long)] })).toContain(
      'A script can read all of it: logsOf("s4") …]',
    );
    expect(marker({ ok: false, error: { kind: 'script', message: long }, output: [] })).toContain(
      'A script can read all of it: logsOf("s4") …]',
    );
    expect(marker({ ok: true, value: 'short', output: [] })).toBe('(not cut)');
    // With no script named, there is only one way to see more.
    expect(renderScript({ result: { ok: true, value: long, output: [] } as never }, 100)).toContain(
      'Return less to see all of it …]',
    );
  });

  it('is kept as what it returned, and as everything else it would be shown of it', () => {
    const output = [{ type: 'text', text: 'given back' }, logged('printed')];
    expect(keptOf({ result: { ok: true, value: { n: 1 }, output } as never })).toEqual({
      ended: 'returned',
      value: '{"n":1}',
      logs: 'given back\nprinted',
    });
    expect(keptOf({ result: { ok: true, output: [] } as never })).toEqual({
      ended: 'returned',
      value: null,
      logs: '',
    });
    const failed = { ok: false, error: { kind: 'script', name: 'Error', message: 'no' }, output };
    expect(keptOf({ result: failed as never })).toEqual({
      ended: 'failed',
      value: null,
      logs: 'given back\nprinted\nError: no\n[failed]',
    });
    const late = { ok: false, error: { kind: 'timeout', message: 'late' }, output };
    expect(keptOf({ result: late as never, notes: ['[how far]'] })).toEqual({
      ended: 'stopped',
      value: null,
      logs: 'given back\nprinted\n[how far]',
    });
  });
});
