// What an engine and a machine's daemon say to each other, over one WebSocket the daemon
// opens. Every frame is one JSON object with a `type`.
//
// A connection starts with the daemon proving which machine it is:
//
//   engine → daemon   challenge { nonce }
//   daemon → engine   proof { signature }     the nonce, signed with the machine's key
//   engine → daemon   ready
//   daemon → engine   hello { … }             what the machine is, and what it has
//
// After that the engine sends requests, each with an ID, and the daemon answers each with a
// response of that ID, in whatever order they are done. The daemon knows nothing of waiting or
// of tasks let go of: it starts a command, and says when it ended.
//
// The daemon's side of the same messages is `apps/machine/src/protocol.rs`.

import { z } from 'zod';

/** A command is named by the actor and the task it is for. */
export type CommandRef = {
  readonly actor: string;
  readonly task: string;
};

/** An actor's ID and a task's are both a folder's name on the machine. */
export const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** The most bytes one `read` or `write` moves. */
export const FILE_BYTES = 8 << 20;

const ref = { actor: z.string(), task: z.string() };

/** What stopped a command that did not end by itself, as its machine says it. */
export const stoppedOnMachineSchema = z.enum(['stop', 'timeout', 'output']);
export type StoppedOnMachine = z.infer<typeof stoppedOnMachineSchema>;

export const helloSchema = z.object({
  type: z.literal('hello'),
  os: z.string(),
  arch: z.string(),
  /** The home directory of the daemon's user: what `~` is on the machine. */
  home: z.string(),
  hostname: z.string(),
  /** The daemon's version. */
  version: z.string(),
  /** The SHA-256 of the daemon's own program, in hex: which build of it this is. */
  build: z.string().optional(),
  /** The folder its commands are kept in: one's output is at `<tasks>/<actor>/<task>/output.log`. */
  tasks: z.string().optional(),
  /** The commands that are running, each with where its output is. */
  running: z.array(z.object({ ...ref, log: z.string() })),
  /** The commands that ended and whose ending the engine has not acknowledged: each follows. */
  ended: z.array(z.object(ref)),
});
export type Hello = z.infer<typeof helloSchema>;

/**
 * How a command ended. The daemon keeps it and sends it again on every connection until the
 * engine acknowledges it.
 */
export const endedSchema = z.object({
  type: z.literal('ended'),
  ...ref,
  /**
   * `exited` when it ended by itself, `stopped` when the daemon ended it, `lost` when it is
   * gone and left nothing to say how.
   */
  status: z.enum(['exited', 'stopped', 'lost']),
  /** Its exit status. Null when it was killed and left none. */
  exit: z.number().int().nullable(),
  by: stoppedOnMachineSchema.optional(),
  ranMs: z.number().nonnegative(),
  /** How much it wrote. */
  bytes: z.number().nonnegative(),
  lines: z.number().nonnegative(),
  /** The end of what it wrote. */
  tail: z.string(),
});
export type CommandEnded = z.infer<typeof endedSchema>;

/** Why a daemon refused a request. */
export const machineErrorSchema = z.enum([
  /** The request is not one the daemon takes. */
  'invalid',
  /** `run`: there is no such directory to start in. */
  'bad_cwd',
  /** No such command, or no such file. */
  'not_found',
  /** `write`: what it was to follow is not the end of the file. */
  'not_at_end',
  'not_a_file',
  'permission_denied',
  /** The daemon could not do it. */
  'failed',
]);
export type MachineErrorCode = z.infer<typeof machineErrorSchema>;

/** What a daemon sends. What is none of these is passed over. */
export const fromDaemonSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('proof'), signature: z.string() }),
  helloSchema,
  z.object({
    type: z.literal('response'),
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ code: machineErrorSchema, message: z.string() }).optional(),
  }),
  endedSchema,
  z.object({ type: z.literal('ping') }),
]);
export type FromDaemon = z.infer<typeof fromDaemonSchema>;

export type RunParams = CommandRef & {
  /** Run by bash, with no input. */
  readonly command: string;
  /** Where it starts: an absolute path, or one that starts with `~`. */
  readonly cwd: string;
  /** Seconds it may run before it is stopped. Without it, no limit. */
  readonly timeout?: number;
  /** Variables it is run with, over the machine's own. They are kept nowhere on the machine. */
  readonly env?: { readonly [name: string]: string };
};

export type ReadParams = {
  /** An absolute path, one that starts with `~`, or one relative to `cwd`. */
  readonly path: string;
  readonly cwd?: string;
  /** The first byte to read. 0 without it. */
  readonly from?: number;
  /** How many bytes to read at most. 1 MiB without it, and never more than 8 MiB. */
  readonly max?: number;
};

export type ReadResult = {
  /** How large the file is. */
  readonly size: number;
  readonly from: number;
  /** The bytes read, in base64. */
  readonly data: string;
};

export type WriteParams = {
  readonly path: string;
  readonly cwd?: string;
  /** Where the bytes go. 0, without it: in place of all the file had. Otherwise the file's size. */
  readonly from?: number;
  /** The bytes, in base64: at most `FILE_BYTES`. */
  readonly data: string;
};

export type WriteResult = {
  /** The file, as the machine names it. */
  readonly path: string;
  /** How large it is now. */
  readonly size: number;
};

/** What the engine asks of a daemon, by method. */
export type MachineRequests = {
  readonly run: { readonly params: RunParams; readonly result: { readonly log: string } };
  /** The ending follows as an event. */
  readonly stop: { readonly params: CommandRef; readonly result: object };
  readonly read: { readonly params: ReadParams; readonly result: ReadResult };
  /** Its folders are made where there are none. */
  readonly write: { readonly params: WriteParams; readonly result: WriteResult };
  /** The daemon takes the engine's own build of it, of this digest, in place of itself. */
  readonly update: {
    readonly params: { readonly digest: string };
    readonly result: { readonly updated: boolean; readonly build: string };
  };
};

/** What the engine sends. */
export type FromEngine =
  | { readonly type: 'challenge'; readonly nonce: string }
  | { readonly type: 'ready' }
  | {
      readonly type: 'request';
      readonly id: number;
      readonly method: string;
      readonly params: unknown;
    }
  | ({ readonly type: 'ack' } & CommandRef)
  | { readonly type: 'pong' };

/** What a machine signs to prove itself: its ID and the engine's nonce. */
export function proofText(machine: string, nonce: string): string {
  return `machine ${machine}\n${nonce}`;
}

/** Where a daemon connects, on an engine. */
export function connectPath(machine: string): string {
  return `/v1/machines/${machine}/connect`;
}

/** The machine a daemon's connection is for, by the path it asked for. Undefined for any other path. */
export function machineOfConnectPath(path: string): string | undefined {
  return /^\/v1\/machines\/([^/?]+)\/connect(?:\?.*)?$/.exec(path)?.[1];
}

/** Where an engine hands out the daemon for a system, such as `/machine/linux-x64`. */
export function machineDownloadPath(os: string, arch: string): string {
  return `/machine/${os}-${arch}`;
}
