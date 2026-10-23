// The dev UI, in the browser. Everything about sessions comes over the
// protocol through @acentric/client; builds, deploys and upgrades come from
// the dev server's event stream.

import { connectWebSocket } from '@acentric/client';
import type {
  Answer,
  SessionEvent,
  SessionInfo,
  SessionListing,
  RunnerClient,
  Subscription,
} from '@acentric/client';
import type { Json, JsonObject, LogEntry } from '@acentric/types';

type DevEvent =
  | { type: 'building'; at: number; agent: string }
  | {
      type: 'built';
      at: number;
      agent: string;
      version: string;
      deployed: boolean;
      warnings: string[];
    }
  | { type: 'build_failed'; at: number; agent: string; error: string }
  | {
      type: 'upgraded';
      at: number;
      agent: string;
      session: string;
      from: string;
      to: string;
      answer: Answer;
    };

const state = {
  client: null as RunnerClient | null,
  connected: false,
  versions: {} as Record<string, string>,
  devEvents: [] as DevEvent[],
  sessions: [] as SessionListing[],
  selected: null as string | null,
  info: null as SessionInfo | null,
  entries: [] as LogEntry[],
  expanded: new Set<number>(),
  subscription: null as Subscription | null,
  answer: { text: '', bad: false },
};

const root = element('div', { id: 'app' });
document.querySelector('#app')?.replaceWith(root);
const asideView = element('aside');
const headView = element('div', { class: 'head' });
const bodyView = element('div', { class: 'body' });
const answerView = element('div', { class: 'answer' });
let composerKind = recall('kind') ?? 'prompt';
let composerPayload = recall(`payload:${composerKind}`) ?? '';
const composerView = composer();
root.append(asideView, element('main', {}, [headView, bodyView, composerView]));

// ---- talking to the dev server ----------------------------------------------

async function connect(): Promise<void> {
  try {
    const client = await connectWebSocket(`ws://${location.host}`, { name: 'dev-ui' });
    state.client = client;
    state.connected = true;
    void client.closed.then(() => {
      state.connected = false;
      state.client = null;
      render();
      setTimeout(() => void connect(), 1000);
    });
    await refreshSessions();
    if (state.selected !== null) await select(state.selected);
  } catch {
    setTimeout(() => void connect(), 1000);
  }
  render();
}

async function loadDevState(): Promise<void> {
  const response = await fetch('/dev/state');
  const body: unknown = await response.json();
  if (typeof body === 'object' && body !== null) {
    const versions: unknown = Reflect.get(body, 'versions');
    const events: unknown = Reflect.get(body, 'events');
    if (typeof versions === 'object' && versions !== null) state.versions = fromDevServer(versions);
    if (Array.isArray(events)) state.devEvents = fromDevServer(events);
  }
  const source = new EventSource('/dev/events');
  source.addEventListener('message', (incoming: MessageEvent<string>) => {
    const event = fromDevServer<DevEvent>(JSON.parse(incoming.data));
    state.devEvents = [...state.devEvents.slice(-199), event];
    if (event.type === 'built')
      state.versions = { ...state.versions, [event.agent]: event.version };
    if (event.type === 'upgraded') {
      void refreshSessions();
      if (event.session === state.selected) void refreshInfo();
    }
    render();
  });
}

async function refreshSessions(): Promise<void> {
  if (state.client === null) return;
  state.sessions = await state.client.list();
  render();
}

async function refreshInfo(): Promise<void> {
  if (state.client === null || state.selected === null) return;
  state.info = await state.client.get(state.selected);
  render();
}

async function select(id: string): Promise<void> {
  const client = state.client;
  if (client === null) return;
  await state.subscription?.close().catch(() => undefined);
  state.selected = id;
  state.entries = [];
  state.expanded.clear();
  state.answer = { text: '', bad: false };
  state.info = await client.get(id);
  state.subscription = await client.subscribe(id, {}, (event) => onSessionEvent(id, event));
  render();
}

let refreshing: ReturnType<typeof setTimeout> | null = null;

function onSessionEvent(id: string, event: SessionEvent): void {
  if (id !== state.selected) return;
  if (event.type === 'log') {
    state.entries.push(...event.entries);
  } else if (event.type === 'view' && state.info !== null) {
    state.info = { ...state.info, view: event.view };
  } else if (event.type === 'status' && state.info !== null) {
    state.info = { ...state.info, status: event.status, fault: event.fault };
    void refreshSessions();
  }
  // Running effects come from get, at most every 150 ms.
  if (refreshing === null) {
    refreshing = setTimeout(() => {
      refreshing = null;
      void refreshInfo();
    }, 150);
  }
  render();
}

async function send(kind: string, payloadText: string): Promise<void> {
  const client = state.client;
  if (client === null || state.selected === null) return;
  let payload: JsonObject;
  try {
    payload = parseObject(payloadText.trim() === '' ? '{}' : payloadText);
  } catch (error) {
    state.answer = { text: `the payload is not a JSON object: ${message(error)}`, bad: true };
    render();
    return;
  }
  remember('kind', kind);
  remember(`payload:${kind}`, payloadText);
  try {
    const answer = await client.input(state.selected, { kind, payload });
    state.answer = { text: describeAnswer(answer), bad: !('accepted' in answer) };
  } catch (error) {
    state.answer = { text: message(error), bad: true };
  }
  render();
}

async function create(agent: string, configText: string): Promise<string | null> {
  const client = state.client;
  const version = state.versions[agent];
  if (client === null || version === undefined) return null;
  const config = parseObject(configText.trim() === '' ? '{}' : configText);
  remember(`config:${agent}`, configText);
  const answer = await client.create({ name: agent, version }, config);
  if (!('accepted' in answer) || answer.id === undefined) throw new Error(describeAnswer(answer));
  await refreshSessions();
  await select(answer.id);
  return answer.id;
}

// ---- rendering ----------------------------------------------------------------

let pending = false;

/**
 * Renders soon, once however many events arrive first. A timer rather than
 * an animation frame, which browsers hold back in tabs that are not shown.
 */
function render(): void {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    draw();
  }, 16);
}

function draw(): void {
  asideView.replaceChildren(...sidebar());
  const previous = document.getElementById('log');
  const atBottom =
    previous === null || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 40;
  const scrollTop = previous?.scrollTop ?? 0;
  const info = state.info;
  if (info === null) {
    headView.replaceChildren(element('b', {}, ['No session selected']));
    bodyView.replaceChildren(
      element('div', { class: 'empty' }, ['Create a session, or pick one on the left.']),
    );
    composerView.style.display = 'none';
    return;
  }
  headView.replaceChildren(
    element('span', { class: 'id', title: 'session id' }, [info.id]),
    element('span', { class: 'chip' }, [`${info.agent.name}@${info.agent.version}`]),
    element('span', { class: 'badge' }, [
      element('span', { class: `dot ${info.status}` }),
      info.status,
    ]),
  );
  bodyView.replaceChildren(logView(info), sideView(info));
  composerView.style.display = '';
  answerView.className = `answer${state.answer.bad ? ' bad' : ''}`;
  answerView.textContent = state.answer.text || 'Send an input. ⌘/Ctrl+Enter sends.';
  const log = document.getElementById('log');
  if (log !== null) log.scrollTop = atBottom ? log.scrollHeight : scrollTop;
}

function sidebar(): HTMLElement[] {
  const agents = Object.entries(state.versions);
  return [
    element('div', { class: 'brand' }, [
      element('span', {
        class: `dot ${state.connected ? 'connected' : 'disconnected'}`,
        title: state.connected ? 'connected' : 'reconnecting',
      }),
      element('b', {}, ['acentric dev']),
    ]),
    element('div', { class: 'section' }, [
      element('h3', {}, ['Agents']),
      ...(agents.length === 0
        ? [element('div', { class: 'meta' }, ['building…'])]
        : agents.map(([name, version]) =>
            element('div', { class: 'agent' }, [
              element('span', {}, [name]),
              element('span', { class: 'chip' }, [version]),
            ]),
          )),
      element(
        'button',
        { class: 'primary', style: 'margin-top:10px;width:100%', onclick: () => openCreate() },
        ['New session'],
      ),
    ]),
    element('div', { class: 'section' }, [
      element('h3', {}, ['Sessions']),
      ...(state.sessions.length === 0
        ? [element('div', { class: 'meta' }, ['none yet'])]
        : state.sessions.map((session) =>
            element(
              'div',
              {
                class: `session${session.id === state.selected ? ' selected' : ''}`,
                onclick: () => void select(session.id),
                title: session.fault ?? session.id,
              },
              [
                element('span', { class: `dot ${session.status}` }),
                element('div', {}, [
                  element('div', { class: 'mono' }, [session.id.slice(0, 8)]),
                  element('div', { class: 'meta' }, [
                    `${session.agent.name} · ${session.nextSeq - 1} entries`,
                  ]),
                ]),
              ],
            ),
          )),
    ]),
  ];
}

function logView(info: SessionInfo): HTMLElement {
  const children: (Node | string)[] = [];
  if (info.fault !== null) {
    children.push(
      element('div', { class: 'fault' }, [
        info.fault,
        element('small', {}, [
          'Fix the code and save: the upgrade clears the fault and steps the failed message again.',
        ]),
      ]),
    );
  }
  if (state.entries.length === 0)
    children.push(element('div', { class: 'empty' }, ['The log is empty.']));
  for (const entry of state.entries) children.push(entryView(entry));
  return element('div', { class: 'log', id: 'log' }, children);
}

function entryView(entry: LogEntry): HTMLElement {
  const open = state.expanded.has(entry.seq);
  return element(
    'div',
    {
      class: 'entry',
      onclick: () => {
        if (open) state.expanded.delete(entry.seq);
        else state.expanded.add(entry.seq);
        render();
      },
    },
    [
      element('div', { class: 'line' }, [
        element('span', { class: 'seq' }, [`#${entry.seq}`]),
        element('span', { class: 'time' }, [new Date(entry.at).toLocaleTimeString()]),
        element('span', { class: 'kind' }, [entry.kind]),
        element('span', { class: 'summary' }, [summarize(entry.body)]),
      ]),
      ...(open ? [element('pre', {}, [JSON.stringify(entry.body, null, 2)])] : []),
    ],
  );
}

function sideView(info: SessionInfo): HTMLElement {
  const recent = state.devEvents
    .filter((event) => event.type !== 'building')
    .slice(-12)
    .toReversed();
  return element('div', { class: 'side' }, [
    element('div', { class: 'section' }, [
      element('h3', {}, ['View']),
      element('pre', {}, [JSON.stringify(info.view, null, 2)]),
    ]),
    element('div', { class: 'section' }, [
      element('h3', {}, ['Running effects']),
      ...(info.running.length === 0
        ? [element('div', { class: 'meta' }, ['none'])]
        : info.running.map((effect) =>
            element('div', { class: 'effect' }, [
              element('span', { class: 'mono' }, [effect.key]),
              element('span', { class: 'meta' }, [
                `${effect.kind}${effect.attempt > 1 ? ` · attempt ${effect.attempt}` : ''}${effect.abort ? ' · aborting' : ''}${effect.active ? '' : ' · waiting'}`,
              ]),
            ]),
          )),
    ]),
    element('div', { class: 'section' }, [
      element('h3', {}, ['Dev']),
      ...(recent.length === 0
        ? [element('div', { class: 'meta' }, ['nothing yet'])]
        : recent.map(devEventView)),
    ]),
  ]);
}

function devEventView(event: DevEvent): HTMLElement {
  const time = new Date(event.at).toLocaleTimeString();
  switch (event.type) {
    case 'built':
      return element('div', { class: 'event ok' }, [
        `${time} ${event.deployed ? 'deployed' : 'unchanged'} ${event.agent} ${event.version}`,
      ]);
    case 'build_failed':
      return element('div', { class: 'event bad' }, [
        `${time} build of ${event.agent} failed`,
        element('pre', {}, [event.error]),
      ]);
    case 'upgraded':
      return element('div', { class: `event ${'accepted' in event.answer ? 'ok' : 'bad'}` }, [
        `${time} ${'accepted' in event.answer ? 'upgraded' : 'could not upgrade'} ${event.session.slice(0, 8)} to ${event.to}`,
      ]);
    case 'building':
      return element('div', { class: 'event' }, [`${time} building ${event.agent}`]);
  }
}

function composer(): HTMLElement {
  const kind = element('input', {
    id: 'kind',
    value: composerKind,
    placeholder: 'input kind',
    list: 'kinds',
  });
  const payload = element('textarea', { id: 'payload', rows: '3', placeholder: '{"text": "…"}' }, [
    composerPayload,
  ]);
  kind.addEventListener('input', () => {
    composerKind = kind.value;
  });
  payload.addEventListener('input', () => {
    composerPayload = payload.value;
  });
  payload.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
      void send(composerKind, composerPayload);
  });
  kind.addEventListener('change', () => {
    const saved = recall(`payload:${kind.value}`);
    if (saved !== null) payload.value = composerPayload = saved;
  });
  return element('div', { class: 'composer' }, [
    kind,
    payload,
    element(
      'button',
      { class: 'primary', onclick: () => void send(composerKind, composerPayload) },
      ['Send'],
    ),
    answerView,
  ]);
}

function openCreate(): void {
  const agents = Object.keys(state.versions);
  if (agents.length === 0) return;
  const agentSelect = element(
    'select',
    { id: 'create-agent' },
    agents.map((name) =>
      element('option', { value: name }, [`${name} (${state.versions[name] ?? ''})`]),
    ),
  );
  const config = element('textarea', { id: 'create-config', rows: '8' }, [
    recall(`config:${agents[0] ?? ''}`) ?? '{}',
  ]);
  agentSelect.addEventListener('change', () => {
    config.value = recall(`config:${agentSelect.value}`) ?? '{}';
  });
  const error = element('div', { class: 'answer bad' });
  const dialog: HTMLDialogElement = element('dialog', {}, [
    element('h2', {}, ['New session']),
    element('label', {}, ['Agent']),
    agentSelect,
    element('label', {}, ['Config (JSON)']),
    config,
    error,
    element('div', { class: 'actions' }, [
      element('button', { onclick: () => dialog.close() }, ['Cancel']),
      element(
        'button',
        {
          class: 'primary',
          onclick: () => {
            create(agentSelect.value, config.value).then(
              () => dialog.close(),
              (failure: unknown) => {
                error.textContent = message(failure);
              },
            );
          },
        },
        ['Create'],
      ),
    ]),
  ]);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---- helpers ------------------------------------------------------------------

/** A one-line summary of an entry's body: its text if it has any, else its Json. */
function summarize(body: Json): string {
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const content = body['content'];
    if (Array.isArray(content)) {
      const parts = content.flatMap((block) => {
        if (typeof block !== 'object' || block === null || Array.isArray(block)) return [];
        if (block['type'] === 'text' && typeof block['text'] === 'string') return [block['text']];
        if (block['type'] === 'toolCall' && typeof block['name'] === 'string') {
          return [`→ ${block['name']}(${JSON.stringify(block['arguments'] ?? {})})`];
        }
        return [];
      });
      if (parts.length > 0) return parts.join(' ');
    }
    if (typeof body['text'] === 'string') return body['text'];
  }
  return JSON.stringify(body);
}

function describeAnswer(answer: Answer): string {
  if ('accepted' in answer) return 'accepted';
  if ('rejected' in answer) return `rejected: ${JSON.stringify(answer.rejected)}`;
  return `failed: ${JSON.stringify(answer.failed)}`;
}

function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error('expected a JSON object');
  return value;
}

/** Parsed from JSON text, so it is Json. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the dev server sends, in the shape it sends it. */
// The type parameter names what the server sent; nothing checks it.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
function fromDevServer<T>(value: unknown): T {
  // The dev server writes these values from the same types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as T;
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`acentric-dev:${key}`, value);
  } catch {
    // Storage can be unavailable; remembering inputs is only a convenience.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(`acentric-dev:${key}`);
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Attributes = Record<string, string | (() => void)>;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value === 'function') node.addEventListener(name.slice(2), value);
    else if (name === 'value' && 'value' in node) node.value = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

void loadDevState().then(render);
void connect();
render();
