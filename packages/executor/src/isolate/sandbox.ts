// One workerd process and the one WebSocket the engine talks to it over. Every call is a
// message on that socket with an id, so any number of calls share one connection. The
// protocol is in sandbox/host.js.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:os';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

import type { MachineFilePart, MachineFileRequest, Json } from '@acentric/protocol';

import { BundleError, CallFailed, SandboxLost } from '../errors.ts';
import { renderConfig } from './config.ts';
import type { Network } from './config.ts';

/** Gives the value of a secret for one call, or undefined when none is set by that name. */
export type CallSecrets = (name: string) => Promise<string | undefined>;

/** Reads or writes a part of a file for one call: of the machine of the actor it is for. */
export type CallFiles = (request: MachineFileRequest) => Promise<MachineFilePart | undefined>;

/** What the engine does for one call's code while it runs. */
export type CallAsks = { readonly secrets?: CallSecrets; readonly files?: CallFiles };

const PART = 256 * 1024;

/**
 * Starts workerd so that it dies with the engine, even an engine killed with SIGKILL, whose
 * exit hooks never run. The engine holds the only write end of this shell's stdin. When the
 * engine is gone, a read of it ends, and the shell kills workerd. workerd's pid goes to the
 * control fd, before workerd writes anything there, and the shell exits with workerd's status.
 */
const WATCH = `exec 4<&0
"$@" 0</dev/null 4<&- &
w=$!
printf '{"event":"pid","pid":%s}\\n' "$w" >&3
(while read -r _; do :; done; kill -KILL "$w" 2>/dev/null) 0<&4 3>&- &
r=$!
exec 4<&-
wait "$w"
s=$?
kill "$r" 2>/dev/null
exit "$s"`;

export type SandboxOptions = {
  readonly binary: string;
  /** The directory with host.js and shim.js. */
  readonly files: string;
  readonly network: Network;
  readonly compatibilityDate: string;
  readonly startTimeoutMs: number;
  /** Lines workerd writes to stdout and stderr. */
  readonly log: (line: string) => void;
  /** Called once when the process is gone for any reason but `stop`. */
  readonly onLost: (lost: Sandbox, kind: LossKind, reason: string) => void;
  /** Counts calls rejected with SandboxLost, by why. */
  readonly onRejected: (kind: LossKind | 'closed', calls: number) => void;
  /** How many bundles the process loads at once. */
  readonly loadConcurrency: number;
};

/** Why a process was killed: no message for stallMs, it exited, its socket closed, or it did not drain in time. */
export type LossKind = 'stall' | 'exit' | 'connection' | 'drain';

type Pending = {
  readonly resolve: (value: Json) => void;
  readonly reject: (error: unknown) => void;
  readonly asks: CallAsks;
  /** Sends the call; with `withCode`, with its bundle's code whatever this side believes. */
  readonly send: (withCode: boolean) => void;
  /** Whether the call has gone to the process. */
  sent: boolean;
};

/** A call sent to the process: its answer, and a way to stop waiting for it. */
export type Request = {
  readonly result: Promise<Json>;
  /** Cancels the call in the process, and rejects `result` with `error` at once. */
  readonly cancel: (error: unknown) => void;
};

export class Sandbox {
  /** The keys whose code this process holds, or has been sent. */
  readonly bundles = new Set<string>();
  /** Bundles counted in `bundles` whose code has not been sent yet. */
  readonly #unsent = new Set<string>();
  readonly #calls = new Map<number, Pending>();
  /** Calls cancelled after they were sent, whose code has not finished in the process. */
  readonly #abandoned = new Set<number>();
  readonly #codes = new Map<string, Promise<string>>();
  readonly #state: { stopped: boolean };
  readonly #socket: WebSocket;
  readonly #dir: string;
  readonly #options: SandboxOptions;
  #ids = 0;
  #parts: string[] = [];
  #ping: { readonly n: number; readonly at: number; timer: NodeJS.Timeout } | undefined;
  /** When the last message of any kind came from workerd: proof it is not stuck. */
  lastMessageAt = Date.now();
  /** When a call was last made into this process. */
  lastCallAt = Date.now();
  /** Bundle loads under way and queued in the process, as it last said. */
  loading = 0;
  queuedLoads = 0;
  #pings = 0;
  #gone = false;
  #draining: NodeJS.Timeout | undefined;
  rssMb = 0;
  /** workerd's pid. */
  readonly pid: number;
  readonly startedAt = Date.now();

  private constructor(
    child: ChildProcess,
    pid: number,
    socket: WebSocket,
    dir: string,
    tail: readonly string[],
    options: SandboxOptions,
    state: { stopped: boolean },
  ) {
    this.#state = state;
    this.#tailLines = tail;
    this.#socket = socket;
    this.#dir = dir;
    this.#options = options;
    this.pid = pid;
    socket.addEventListener('message', (event) => this.#receive(String(event.data)));
    // A process that dies closes the socket too: give its exit, which says more, a moment to come first.
    socket.addEventListener('close', () => {
      setTimeout(() => this.lose('connection', 'the connection to workerd closed'), 200).unref();
    });
    child.on('exit', (code, signal) =>
      this.lose('exit', `workerd exited with ${exitOf(code, signal)}${this.#tail()}`),
    );
  }

  static async start(options: SandboxOptions): Promise<Sandbox> {
    // A short directory for the config: it holds the token, so only this user may read it.
    const dir = await mkdtemp(join(tmpdir(), 'acentric-code-'));
    const token = randomBytes(24).toString('hex');
    await writeFile(
      join(dir, 'config.capnp'),
      renderConfig({
        network: options.network,
        token,
        compatibilityDate: options.compatibilityDate,
        loadConcurrency: options.loadConcurrency,
      }),
      { mode: 0o600 },
    );
    await copyFile(join(options.files, 'host.js'), join(dir, 'host.js'));
    await copyFile(join(options.files, 'shim.js'), join(dir, 'shim.js'));
    const child = spawn(
      '/bin/sh',
      [
        '-c',
        WATCH,
        'watch',
        options.binary,
        'serve',
        join(dir, 'config.capnp'),
        '--experimental',
        '--control-fd=3',
      ],
      // Nothing of the engine's environment, where its keys are: the watch shell uses only
      // its builtins, workerd is run by its path, and its config reads no variable.
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {} },
    );
    let pid = 0;
    const tail: string[] = [];
    // What the shell says of a process this side killed is not news: it is not passed on.
    const state = { stopped: false };
    const lines = (stream: Readable | null): void => {
      let buffer = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          if (line === '') continue;
          tail.push(line);
          if (tail.length > 5) tail.shift();
          if (!state.stopped) options.log(`[workerd ${String(pid)}] ${line}`);
        }
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    try {
      const started = await listening(child, options.startTimeoutMs, tail);
      pid = started.pid;
      const port = started.port;
      const socket = await connect(
        `ws://127.0.0.1:${port}/?token=${token}`,
        options.startTimeoutMs,
      );
      return new Sandbox(child, pid, socket, dir, tail, options, state);
    } catch (error) {
      if (pid !== 0) killQuietly(pid);
      child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** The last lines workerd wrote, which say why it died when it did. */
  readonly #tailLines: readonly string[];
  #tail(): string {
    const last = this.#tailLines.at(-1);
    return last === undefined ? '' : `: ${last}`;
  }

  get inFlight(): number {
    return this.#calls.size;
  }

  get gone(): boolean {
    return this.#gone;
  }

  /** Calls cancelled while their code ran on, and still running. */
  get abandoned(): number {
    return this.#abandoned.size;
  }

  get draining(): boolean {
    return this.#draining !== undefined;
  }

  /**
   * Sends a call. `code` is asked for when this process does not hold the
   * bundle, or says it does not.
   */
  request(
    t: 'call' | 'inspect',
    hash: string,
    code: () => Promise<string>,
    body: { readonly [key: string]: Json },
    asks: CallAsks = {},
  ): Request {
    const id = ++this.#ids;
    this.lastCallAt = Date.now();
    let reject: (error: unknown) => void = () => {};
    const result = new Promise<Json>((resolve, rejectResult) => {
      reject = rejectResult;
      if (this.#gone) return rejectResult(new SandboxLost('the process is gone'));
      const send = (withCode: boolean): void => {
        if (!withCode && this.bundles.has(hash) && !this.#unsent.has(hash)) {
          return void this.#post(id, { t, id, key: hash, ...body });
        }
        // Counted from now, so calls that come meanwhile see how many bundles this process will hold.
        if (!this.bundles.has(hash)) {
          this.bundles.add(hash);
          this.#unsent.add(hash);
        }
        this.#codeOf(hash, code).then(
          (text) => {
            if (!this.#calls.has(id)) return;
            // The first call to get the code sends it; the others come after it on the socket.
            const sendCode = withCode || this.#unsent.delete(hash);
            this.#post(id, { t, id, key: hash, ...(sendCode ? { code: text } : {}), ...body });
          },
          (error: unknown) => {
            if (this.#unsent.delete(hash)) this.bundles.delete(hash);
            this.#settle(id)?.reject(error);
          },
        );
      };
      this.#calls.set(id, {
        resolve,
        reject: rejectResult,
        asks,
        send,
        sent: false,
      });
      send(false);
    });
    return {
      result,
      cancel: (error) => {
        const call = this.#settle(id);
        if (call === undefined) return;
        // A call not sent yet never will be.
        if (call.sent) {
          this.#abandoned.add(id);
          this.#send({ t: 'cancel', id });
        }
        reject(error);
      },
    };
  }

  /**
   * Sends a ping, unless one is out. A process is stuck only when it has sent
   * nothing at all for `stallMs` while the ping waits: one thread serves every
   * isolate, so a ping may queue behind loads and calls, and any answer, load,
   * or question of a call's in the meantime shows it is working.
   */
  probe(stallMs: number): void {
    if (this.#gone || this.#ping !== undefined) return;
    const n = ++this.#pings;
    const at = Date.now();
    const check = (): void => {
      const quiet = Date.now() - Math.max(this.lastMessageAt, at);
      if (quiet >= stallMs) {
        return this.lose(
          'stall',
          `workerd sent nothing for ${stallMs} ms while a ping waited, so it was killed`,
        );
      }
      if (this.#ping?.n !== n) return;
      this.#ping.timer = setTimeout(check, stallMs - quiet);
      this.#ping.timer.unref();
    };
    const timer = setTimeout(check, stallMs);
    timer.unref();
    this.#ping = { n, at, timer };
    this.#send({ t: 'ping', n });
    void readRss(this.pid).then((mb) => {
      if (mb !== undefined) this.rssMb = mb;
    });
  }

  /**
   * Takes no new calls, and is killed once its calls in flight are over, or
   * after `drainMs`, when those still in flight reject with SandboxLost.
   */
  drain(drainMs: number, reason: string): void {
    if (this.#gone || this.#draining !== undefined) return;
    this.#draining = setTimeout(
      () => this.lose('drain', `${reason}, and its calls did not finish within ${drainMs} ms`),
      drainMs,
    );
    this.#draining.unref();
    this.#maybeDrained();
  }

  /** Kills the process at once; every call in flight rejects with SandboxLost(reason). */
  lose(kind: LossKind, reason: string): void {
    if (this.#gone) return;
    this.#stop();
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    for (const call of calls) call.reject(new SandboxLost(reason));
    if (calls.length > 0) this.#options.onRejected(kind, calls.length);
    this.#options.onLost(this, kind, reason);
  }

  /** Kills the process; calls in flight reject with SandboxLost. Does not count as lost. */
  stop(): void {
    if (this.#gone) return;
    this.#stop();
    for (const call of this.#calls.values())
      call.reject(new SandboxLost('the executor was closed'));
    if (this.#calls.size > 0) this.#options.onRejected('closed', this.#calls.size);
    this.#calls.clear();
  }

  /** Closes the socket as if the connection broke. For tests. */
  disconnect(): void {
    this.#socket.close();
  }

  #stop(): void {
    this.#gone = true;
    this.#state.stopped = true;
    if (this.#ping !== undefined) clearTimeout(this.#ping.timer);
    if (this.#draining !== undefined) clearTimeout(this.#draining);
    // workerd itself: the shell around it exits with it.
    killQuietly(this.pid);
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
    void rm(this.#dir, { recursive: true, force: true });
  }

  #maybeDrained(): void {
    if (this.#draining !== undefined && this.#calls.size === 0) this.stop();
  }

  #settle(id: number): Pending | undefined {
    const call = this.#calls.get(id);
    if (call === undefined) return undefined;
    this.#calls.delete(id);
    // Settled before it is resolved, so a drained process stops after its last answer is handed on.
    queueMicrotask(() => this.#maybeDrained());
    return call;
  }

  #codeOf(hash: string, code: () => Promise<string>): Promise<string> {
    let loading = this.#codes.get(hash);
    if (loading === undefined) {
      loading = code().finally(() => this.#codes.delete(hash));
      this.#codes.set(hash, loading);
    }
    return loading;
  }

  #post(id: number, message: { readonly [key: string]: Json | undefined }): void {
    const call = this.#calls.get(id);
    if (call !== undefined) call.sent = true;
    this.#send(message);
  }

  #send(message: { readonly [key: string]: Json | undefined }): void {
    if (this.#gone) return;
    const text = JSON.stringify(message);
    if (text.length <= PART) return this.#socket.send(text);
    for (let at = 0; at < text.length; at += PART) {
      const t = at + PART >= text.length ? 'last' : 'part';
      this.#socket.send(JSON.stringify({ t, d: text.slice(at, at + PART) }));
    }
  }

  #receive(data: string): void {
    this.lastMessageAt = Date.now();
    let message = JSON.parse(data) as { readonly [key: string]: Json };
    if (message['t'] === 'part') return void this.#parts.push(String(message['d']));
    if (message['t'] === 'last') {
      this.#parts.push(String(message['d']));
      message = JSON.parse(this.#parts.join('')) as { readonly [key: string]: Json };
      this.#parts = [];
    }
    const id = Number(message['id']);
    // The code of a cancelled call has finished, or never ran.
    if (message['t'] === 'result' || message['t'] === 'failed' || message['t'] === 'needCode') {
      this.#abandoned.delete(id);
    }
    switch (message['t']) {
      case 'pong': {
        const ping = this.#ping;
        if (ping !== undefined && ping.n === message['n']) {
          clearTimeout(ping.timer);
          this.#ping = undefined;
        }
        this.loading = Number(message['loading'] ?? 0);
        this.queuedLoads = Number(message['queued'] ?? 0);
        return;
      }
      case 'loaded':
        this.loading = Number(message['loading'] ?? 0);
        this.queuedLoads = Number(message['queued'] ?? 0);
        return;
      case 'result':
        return this.#settle(id)?.resolve(message['result'] ?? null);
      case 'failed':
        return this.#settle(id)?.reject(
          message['load'] === true
            ? new BundleError(`The code does not load: ${String(message['message'])}`)
            : new CallFailed(`The call failed: ${String(message['message'])}`),
        );
      case 'needCode':
        // The process lost the bundle, or never had it: send the call again, with the code.
        return this.#calls.get(id)?.send(true);
      case 'secret':
        return void this.#secret(id, Number(message['sid']), String(message['name']));
      case 'file':
        return void this.#file(id, Number(message['sid']), message['request'] ?? null);
      default:
        return;
    }
  }

  /** Answers a call's question for a secret, with what the engine has or why it has not. */
  async #secret(id: number, sid: number, name: string): Promise<void> {
    try {
      const secrets = this.#calls.get(id)?.asks.secrets;
      if (secrets === undefined) {
        throw new Error(this.#calls.has(id) ? 'The call has no secrets' : 'The call is over');
      }
      this.#send({ t: 'secret', id, sid, value: await secrets(name) });
    } catch (error) {
      const { name: errorName, message } =
        error instanceof Error ? error : { name: 'Error', message: String(error) };
      this.#send({ t: 'secret', id, sid, error: { name: errorName, message } });
    }
  }

  /** Answers a call's question for a part of a file, with the part or why there is none. */
  async #file(id: number, sid: number, request: Json): Promise<void> {
    try {
      const files = this.#calls.get(id)?.asks.files;
      if (files === undefined) {
        throw new Error(this.#calls.has(id) ? 'The actor has no machine' : 'The call is over');
      }
      const part = await files(request as unknown as MachineFileRequest);
      this.#send({ t: 'file', id, sid, ...(part === undefined ? {} : { value: part }) });
    } catch (error) {
      const { name: errorName, message } =
        error instanceof Error ? error : { name: 'Error', message: String(error) };
      this.#send({ t: 'file', id, sid, error: { name: errorName, message } });
    }
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone already.
  }
}

/** How a process ended. The shell around workerd exits with 128 + n when workerd died of signal n. */
function exitOf(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return signal;
  if (code !== null && code > 128) {
    const name = Object.entries(constants.signals).find(([, n]) => n === code - 128)?.[0];
    if (name !== undefined) return name;
  }
  return `code ${String(code)}`;
}

/** workerd's pid and the port it listens on, from its control fd. */
function listening(
  child: ChildProcess,
  timeoutMs: number,
  tail: string[],
): Promise<{ readonly pid: number; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const control = child.stdio[3] as Readable | null;
    let buffer = '';
    let pid = 0;
    const timer = setTimeout(
      () => fail(`workerd did not listen within ${timeoutMs} ms`),
      timeoutMs,
    );
    const fail = (message: string): void => {
      clearTimeout(timer);
      reject(new Error(tail.length === 0 ? message : `${message}: ${tail.join('\n')}`));
    };
    control?.setEncoding('utf8');
    control?.on('data', (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split('\n')) {
        try {
          const event = JSON.parse(line) as {
            event?: string;
            socket?: string;
            port?: number;
            pid?: number;
          };
          if (event.event === 'pid' && event.pid !== undefined) pid = event.pid;
          if (event.event === 'listen' && event.socket === 'engine' && event.port !== undefined) {
            clearTimeout(timer);
            resolve({ pid, port: event.port });
          }
        } catch {
          // A line not finished yet.
        }
      }
    });
    child.on('error', (error) => fail(`workerd did not start: ${error.message}`));
    // Read the tail on the next turn: stderr may arrive just after the exit.
    child.on('exit', (code, signal) =>
      setTimeout(() => fail(`workerd exited with ${exitOf(code, signal)}`), 50),
    );
  });
}

function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`workerd did not take a connection within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('could not connect to workerd'));
    });
  });
}

const execFileAsync = promisify(execFile);

/** The resident set size of a process, in MB: from /proc on Linux, from ps elsewhere. */
export async function readRss(pid: number): Promise<number | undefined> {
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb === undefined ? undefined : Number(kb) / 1024;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : undefined;
  } catch {
    return undefined;
  }
}
