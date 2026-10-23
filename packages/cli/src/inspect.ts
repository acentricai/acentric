// The commands that inspect and drive a running runner over its WebSocket:
// agents, ls, create, send, get, log [-f] and upgrade.

import { connectWebSocket } from '@acentric/client';
import type { RunnerClient } from '@acentric/client';
import type { Json, JsonObject, LogEntry } from '@acentric/types';

export type Output = (line: string) => void;

export async function withClient<T>(
  url: string,
  work: (client: RunnerClient) => Promise<T>,
): Promise<T> {
  let client: RunnerClient;
  try {
    client = await connectWebSocket(url, { name: 'acentric' });
  } catch {
    throw new Error(`no runner at ${url}: is acentric start running?`);
  }
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

export async function agents(client: RunnerClient, out: Output): Promise<void> {
  const list = await client.listAgents();
  if (list.length === 0) out('no agents deployed');
  for (const agent of list) {
    out(
      `${agent.name}@${agent.version}  ${agent.hash.slice(0, 12)}  ${agent.instances} instance${agent.instances === 1 ? '' : 's'}`,
    );
  }
}

export async function ls(client: RunnerClient, out: Output): Promise<void> {
  const instances = await client.list();
  if (instances.length === 0) out('no instances');
  for (const instance of instances) {
    const fault = instance.fault === null ? '' : `  ${instance.fault}`;
    out(
      `${instance.id}  ${instance.agent.name}@${instance.agent.version}  ${instance.status}  ${instance.nextSeq - 1} entries  ${instance.running} running${fault}`,
    );
  }
}

export async function create(
  client: RunnerClient,
  out: Output,
  agent: string,
  config: JsonObject,
  id: string | undefined,
): Promise<boolean> {
  const answer = await client.create(agent, config, id === undefined ? {} : { id });
  if ('accepted' in answer) {
    out(answer.id ?? '');
    return true;
  }
  out(JSON.stringify(answer));
  return false;
}

export async function send(
  client: RunnerClient,
  out: Output,
  id: string,
  kind: string,
  payload: JsonObject,
  inputId: string | undefined,
): Promise<boolean> {
  const answer = await client.input(id, {
    kind,
    payload,
    ...(inputId === undefined ? {} : { id: inputId }),
  });
  out(JSON.stringify(answer));
  return 'accepted' in answer;
}

export async function get(
  client: RunnerClient,
  out: Output,
  id: string,
  snapshot: boolean,
): Promise<void> {
  out(JSON.stringify(await client.get(id, { snapshot }), null, 2));
}

export async function upgrade(
  client: RunnerClient,
  out: Output,
  id: string,
  version: string,
): Promise<boolean> {
  const answer = await client.upgrade(id, version);
  out(JSON.stringify(answer));
  return 'accepted' in answer;
}

export type LogOptions = { follow: boolean; emits: boolean; json: boolean; after: number };

/** Prints the log, and with `follow`, each step as it is saved, until the returned promise is cancelled by the caller. */
export async function log(
  client: RunnerClient,
  out: Output,
  write: (text: string) => void,
  id: string,
  options: LogOptions,
): Promise<void> {
  const print = (entry: LogEntry): void =>
    out(options.json ? JSON.stringify(entry) : formatEntry(entry));
  if (!options.follow) {
    let after = options.after;
    for (;;) {
      // Reading the log a page at a time.
      // oxlint-disable-next-line no-await-in-loop
      const page = await client.log(id, { after });
      for (const entry of page.entries) print(entry);
      const last = page.entries.at(-1);
      if (page.cursor === undefined || last === undefined) return;
      after = last.seq;
    }
  }
  let streaming = false;
  await client.subscribe(id, { after: options.after, emits: options.emits }, (event) => {
    if (event.type === 'log') {
      if (streaming) write('\n');
      streaming = false;
      for (const entry of event.entries) print(entry);
    } else if (event.type === 'emit') {
      const text = deltaText(event.delta);
      if (text !== null) {
        streaming = true;
        write(text);
      }
    } else if (event.type === 'status' && !options.json) {
      out(`-- ${event.status}${event.fault === null ? '' : `: ${event.fault}`}`);
    }
  });
  await client.closed;
}

/** One line per entry: its number, time, kind and body, cut to fit. */
export function formatEntry(entry: LogEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 19);
  const body = JSON.stringify(entry.body);
  const shown = body.length > 200 ? `${body.slice(0, 199)}…` : body;
  return `#${entry.seq}  ${time}  ${entry.kind}  ${shown}`;
}

/** The text in a streamed delta, for deltas that carry text, such as a model's reply. */
function deltaText(delta: Json): string | null {
  if (typeof delta === 'string') return delta;
  if (typeof delta === 'object' && delta !== null && !Array.isArray(delta)) {
    const text = delta['delta'] ?? delta['text'];
    if (typeof text === 'string') return text;
  }
  return null;
}
