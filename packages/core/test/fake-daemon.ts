// A machine's daemon, for tests of the engine's side: it says what a daemon says, over a
// connection that is two ends in one process, and has nothing of a machine behind it.

import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { proofText } from '@acentric/protocol';
import type {
  CommandEnded,
  CommandRef,
  FromDaemon,
  FromEngine,
  MachineErrorCode,
  MachineId,
} from '@acentric/protocol';

import type { MachineSocket, Machines } from '../src/machines.ts';

const keyOf = (ref: CommandRef): string => `${ref.actor}/${ref.task}`;

/** What a daemon's end of a connection is told. */
type DaemonEnd = {
  send(message: FromDaemon | { readonly [key: string]: unknown }): void;
  close(): void;
  /** How the engine closed it, once it has. */
  closedBy?: { readonly code?: number; readonly reason?: string };
  open: boolean;
  /** Called once it has said what it has, or is closed. */
  greeted: () => void;
};

export type Refusal = { readonly code: MachineErrorCode; readonly message: string };

export class FakeDaemon {
  #keys = generateKeyPairSync('ed25519');
  /** What the machine says it is. */
  facts = {
    os: 'linux',
    arch: 'x64',
    home: '/home/u',
    hostname: 'box',
    version: '0.1.0',
    build: 'build-1' as string | undefined,
    tasks: '/home/u/.acentric-machine/tasks',
  };
  /** The commands the machine has running, each with where its output is. */
  readonly running = new Map<string, CommandRef & { log: string }>();
  /** The endings the engine has not acknowledged. */
  readonly unacked = new Map<string, CommandEnded>();
  /** Every request the engine made, in order. */
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  /** Every acknowledgement the engine sent. */
  readonly acks: string[] = [];
  readonly files = new Map<string, Buffer>();
  /** Says no to a request, when it gives why. */
  refuse: (method: string, params: Record<string, unknown>) => Refusal | undefined = () =>
    undefined;
  /** Answers no request. */
  silent = false;
  /** Signs with a key that is not the machine's. */
  impostor = false;
  /** Never proves itself. */
  mute = false;
  /** Called when the engine asks for a command to be run, after it is taken. */
  onRun: (params: Record<string, unknown>) => void = () => {};
  /** What an `update` request is answered with. */
  onUpdate: (digest: string) => { updated: boolean; build: string } = (digest) => ({
    updated: false,
    build: digest,
  });
  link: DaemonEnd | undefined;

  /** The public half of its key, as it enrols with it. */
  get publicKey(): string {
    return (this.#keys.publicKey as KeyObject)
      .export({ format: 'der', type: 'spki' })
      .toString('base64');
  }

  /** Takes a new key: one the engine has not been given. */
  rekey(): void {
    this.#keys = generateKeyPairSync('ed25519');
  }

  /** Connects, and resolves once it has said what it has, or the engine closed the connection. */
  connect(machines: Machines, id: MachineId): Promise<DaemonEnd> {
    let toDaemon: (text: string) => void = () => {};
    let onMessage: (text: string) => void = () => {};
    let onClose: () => void = () => {};
    let greet: () => void = () => {};
    const greeted = new Promise<void>((resolve) => {
      greet = resolve;
    });
    const end: DaemonEnd = {
      open: true,
      greeted: greet,
      send: (message) => {
        if (!end.open) return;
        const text = JSON.stringify(message);
        queueMicrotask(() => {
          if (end.open) onMessage(text);
        });
      },
      close: () => {
        if (!end.open) return;
        end.open = false;
        if (this.link === end) this.link = undefined;
        queueMicrotask(onClose);
        end.greeted();
      },
    };
    const socket: MachineSocket = {
      send: (text) => {
        queueMicrotask(() => {
          if (end.open) toDaemon(text);
        });
      },
      close: (code, reason) => {
        if (!end.open) return;
        end.closedBy = {
          ...(code === undefined ? {} : { code }),
          ...(reason === undefined ? {} : { reason }),
        };
        end.open = false;
        if (this.link === end) this.link = undefined;
        end.greeted();
      },
      onMessage: (listener) => {
        onMessage = listener;
      },
      onClose: (listener) => {
        onClose = listener;
      },
    };
    toDaemon = (text) => {
      this.#hears(end, id, JSON.parse(text) as FromEngine);
    };
    this.link = end;
    machines.connect(id, socket);
    return greeted.then(() => end);
  }

  /** Goes away, as a daemon that stops or a network that drops does. */
  drop(): void {
    this.link?.close();
  }

  /** A command ended on the machine: the engine is told, again on every connection, until it acknowledges. */
  end(ref: CommandRef, how: Partial<Omit<CommandEnded, 'type' | 'actor' | 'task'>> = {}): void {
    const ended: CommandEnded = {
      type: 'ended',
      actor: ref.actor,
      task: ref.task,
      status: 'exited',
      exit: 0,
      ranMs: 12,
      bytes: 3,
      lines: 1,
      tail: 'hi\n',
      ...how,
    };
    this.running.delete(keyOf(ref));
    this.unacked.set(keyOf(ref), ended);
    this.link?.send(ended);
  }

  /** The requests of one method, in order. */
  asked(method: string): Record<string, unknown>[] {
    return this.requests.filter((one) => one.method === method).map((one) => one.params);
  }

  #hears(end: DaemonEnd, id: MachineId, message: FromEngine): void {
    switch (message.type) {
      case 'challenge': {
        if (this.mute) return;
        const key = this.impostor
          ? generateKeyPairSync('ed25519').privateKey
          : this.#keys.privateKey;
        const signature = sign(null, Buffer.from(proofText(id, message.nonce)), key);
        end.send({ type: 'proof', signature: signature.toString('base64') });
        return;
      }
      case 'ready': {
        const { build, ...facts } = this.facts;
        end.send({
          type: 'hello',
          ...facts,
          ...(build === undefined ? {} : { build }),
          running: [...this.running.values()],
          ended: [...this.unacked.values()].map(({ actor, task }) => ({ actor, task })),
        });
        for (const ended of this.unacked.values()) end.send(ended);
        // After everything this sent has been heard.
        setTimeout(end.greeted, 0);
        return;
      }
      case 'ack':
        this.acks.push(keyOf(message));
        this.unacked.delete(keyOf(message));
        return;
      case 'pong':
        return;
      case 'request': {
        const params = message.params as Record<string, unknown>;
        this.requests.push({ method: message.method, params });
        if (this.silent) return;
        const refused = this.refuse(message.method, params);
        if (refused !== undefined) {
          end.send({ type: 'response', id: message.id, error: refused });
          return;
        }
        end.send({ type: 'response', id: message.id, result: this.#does(message.method, params) });
      }
    }
  }

  #does(method: string, params: Record<string, unknown>): unknown {
    const ref = { actor: String(params['actor']), task: String(params['task']) };
    switch (method) {
      case 'run': {
        const log = `${this.facts.tasks}/${ref.actor}/${ref.task}/output.log`;
        // A command of one name runs once.
        if (!this.running.has(keyOf(ref)) && !this.unacked.has(keyOf(ref))) {
          this.running.set(keyOf(ref), { ...ref, log });
          queueMicrotask(() => {
            this.onRun(params);
          });
        }
        return { log };
      }
      case 'stop':
        if (this.running.has(keyOf(ref))) {
          queueMicrotask(() => {
            this.end(ref, { status: 'stopped', exit: null, by: 'stop', tail: 'so far\n' });
          });
        }
        return {};
      case 'read': {
        const file = this.files.get(String(params['path'])) ?? Buffer.alloc(0);
        const from = Number(params['from'] ?? 0);
        const max = Number(params['max'] ?? 1 << 20);
        return {
          size: file.length,
          from,
          data: file.subarray(from, from + max).toString('base64'),
        };
      }
      case 'write': {
        const path = String(params['path']);
        const from = Number(params['from'] ?? 0);
        const before = from === 0 ? Buffer.alloc(0) : (this.files.get(path) ?? Buffer.alloc(0));
        const now = Buffer.concat([before, Buffer.from(String(params['data']), 'base64')]);
        this.files.set(path, now);
        return { path, size: now.length };
      }
      case 'update':
        return this.onUpdate(String(params['digest']));
      default:
        return {};
    }
  }
}
