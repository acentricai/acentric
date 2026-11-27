// A template at Boat, built by the server: what `deploy/sandbox/boat-template.sh` does by hand,
// through Boat's API, with a script of the person's run first. In a sandbox of the account's
// own, from Boat's base:
//
//   1. the script, as the user `user`, who may use sudo, for as long as it is given
//   2. the machine program for the sandbox's processor, and what starts it with the sandbox
//   3. a check that the machine program runs, and that nothing in the disk has enrolled already
//   4. the disk, saved under the template's name, once Boat says it is saved
//
// The builder is deleted however the build ends. What the script printed and what the install
// printed are kept, the end of it, as the build's output.

import { ProviderFailed, TemplateFailed } from '@acentric/core';
import type { TemplateBuild } from '@acentric/core';
import { TEMPLATE_OUTPUT_MAX_BYTES } from '@acentric/protocol';

/**
 * What a sandbox runs when it starts: the same as `deploy/sandbox/boot`, which the sandbox image
 * and the hand-built template have. A test holds them to one another.
 */
export const BOAT_BOOT = `#!/bin/sh
# What a sandbox runs when it starts, and every time it is started again: the machine program,
# as the user \`user\`. The server that made the sandbox put what its daemon enrols with in
# $provision: the daemon enrols once, and from then on only connects. A sandbox made by hand
# from the same image is given nothing to enrol with, and this ends after a minute.
set -u
provision="$HOME/.acentric-provision.json"
waited=0
while [ ! -e "$HOME/.acentric/machine.json" ] && [ ! -e "$provision" ]; do
  waited=$((waited + 1))
  [ "$waited" -ge 1200 ] && exit 0
  sleep 0.05
done
if [ -e "$provision" ]; then
  acentric-machine provision "$provision" || exit 1
fi
exec acentric-machine connect --foreground
`;

/** The service that runs it: the same as `deploy/sandbox/acentric-machine.service`. */
export const BOAT_UNIT = `[Unit]
Description=The machine program of a sandbox an Acentric server made
Wants=network-online.target
After=network-online.target

[Service]
User=user
Environment=HOME=/home/user
ExecStart=/usr/local/lib/acentric/boot
Restart=on-failure
RestartSec=1

[Install]
WantedBy=multi-user.target
`;

/** Where the build puts what it brings, in the builder. It is removed before the disk is saved. */
const HERE = '/tmp/acentric-template';

/** Installs what was brought, and checks it: what the template's sandboxes start with. */
const INSTALL = `set -eu
sudo install -D -m 755 ${HERE}/acentric-machine /usr/local/bin/acentric-machine
sudo install -D -m 755 ${HERE}/boot /usr/local/lib/acentric/boot
sudo install -D -m 644 ${HERE}/acentric-machine.service /etc/systemd/system/acentric-machine.service
rm -rf ${HERE}
sudo systemctl daemon-reload
sudo systemctl enable acentric-machine.service 2>&1
if [ -e ~/.acentric ]; then
  echo "~/.acentric is there: a sandbox made from this one would not enrol as itself" >&2
  exit 1
fi
rm -f ~/.acentric-provision.json
acentric-machine --version
sync`;

/** Boat's processors, in the machine program's words. */
const ARCH: { readonly [uname: string]: string } = {
  x86_64: 'x64',
  amd64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
};

type Command = {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timedOut?: boolean;
};

type Status = { readonly running?: boolean; readonly exitCode?: number | null };

type Saved = { readonly snapshot?: { readonly status?: string; readonly error?: unknown } };

/** What the build asks Boat with. */
export type BoatCalls = {
  call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
  /** Puts bytes at a signed address Boat gave: with no key. */
  put(url: string, bytes: Uint8Array): Promise<void>;
  /** How long between two looks at something that takes a while. */
  readonly pollMs: number;
  /** How long the builder has to come up, and the disk to be saved. */
  readonly startMs: number;
  readonly saveMs: number;
};

/** The end of a text, at most `max` bytes of it, cut where a character starts. */
export function endOf(text: string, max: number = TEMPLATE_OUTPUT_MAX_BYTES): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let from = bytes.length - max;
  // Not in the middle of a character: its first byte is not 10xxxxxx.
  while (from < bytes.length && ((bytes[from] ?? 0) & 0xc0) === 0x80) from += 1;
  return bytes.subarray(from).toString();
}

/** Builds a template at Boat. See the top of this file. */
export async function buildAtBoat(boat: BoatCalls, build: TemplateBuild): Promise<void> {
  const { signal } = build;
  let printed = '';
  const print = (text: string): void => {
    if (text === '') return;
    printed = endOf(printed + text);
    build.output(printed);
  };
  const stopped = (): never => {
    throw new TemplateFailed('The build was stopped');
  };
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  const step = (): void => {
    if (signal.aborted) stopped();
  };

  step();
  const made = await boat.call<{ sandbox?: { id?: unknown } }>(
    'POST',
    '/sandboxes',
    {
      type: 'small',
      noEnv: true,
      name: `acentric template ${build.label}`,
      // Long enough for all of it: Boat stops it when this runs out, whatever runs in it.
      ttlSeconds: build.scriptSeconds + Math.ceil((boat.startMs + boat.saveMs) / 1000) + 600,
      labels: build.labels,
    },
    { 'idempotency-key': build.key },
  );
  const id = made.sandbox?.id;
  if (typeof id !== 'string') throw new ProviderFailed('Boat answered without a sandbox');
  const one = `/sandboxes/${encodeURIComponent(id)}`;
  const run = (command: string, timeoutSeconds: number): Promise<Command> =>
    boat.call<Command>('POST', `${one}/commands`, { command, timeoutSeconds });
  const write = (path: string, content: string): Promise<unknown> =>
    boat.call('PUT', `${one}/files`, { path, content });

  try {
    // Up first.
    for (const until = Date.now() + boat.startMs; ;) {
      step();
      const state = (await boat.call<{ sandbox?: { state?: string } }>('GET', one)).sandbox?.state;
      if (state === 'ready' || state === 'idle' || state === 'running') break;
      if (state === 'error' || state === 'cancelled') {
        throw new TemplateFailed(`The sandbox the template is built in failed to start (${state})`);
      }
      if (Date.now() >= until) {
        throw new TemplateFailed('The sandbox the template is built in did not start in time');
      }
      await wait(boat.pollMs);
    }

    // 1. The script, with what it prints kept in a file: its end is read while it runs.
    step();
    await write(`${HERE}/script.sh`, build.script);
    const log = `${HERE}/output.log`;
    const started = await boat.call<{ processId?: unknown }>('POST', `${one}/commands`, {
      command: `cd ~ && exec bash ${HERE}/script.sh > ${log} 2>&1 < /dev/null`,
      detached: true,
    });
    if (typeof started.processId !== 'number' && typeof started.processId !== 'string') {
      throw new ProviderFailed('Boat answered without the process of the script');
    }
    const process = `${one}/commands/${encodeURIComponent(String(started.processId))}`;
    let status: Status = {};
    for (const until = Date.now() + build.scriptSeconds * 1000; ;) {
      if (signal.aborted || Date.now() >= until) {
        await boat.call('DELETE', process).catch(() => undefined);
        step();
        throw new TemplateFailed(
          `The script ran for more than ${String(build.scriptSeconds)} seconds, and was stopped`,
        );
      }
      await wait(boat.pollMs);
      status = await boat.call<Status>('GET', process);
      const tail = await run(`tail -c ${String(TEMPLATE_OUTPUT_MAX_BYTES)} ${log}`, 60);
      printed = '';
      print(tail.stdout ?? '');
      if (status.running !== true) break;
    }
    if (status.exitCode !== 0) {
      throw new TemplateFailed(
        status.exitCode === null || status.exitCode === undefined
          ? 'The script was ended before it finished'
          : `The script ended with ${String(status.exitCode)}`,
      );
    }

    // 2. The machine program, for this sandbox's processor, and its start-up.
    step();
    const uname = (await run('uname -m', 60)).stdout?.trim() ?? '';
    const arch = ARCH[uname];
    const program = arch === undefined ? undefined : build.program(arch);
    if (program === undefined) {
      throw new TemplateFailed(
        `This server hands out no machine program for the sandbox's processor, ${uname === '' ? 'which Boat did not say' : uname}`,
      );
    }
    const upload = await boat.call<{ url?: unknown }>('POST', `${one}/files/upload-url`, {
      path: `${HERE}/acentric-machine`,
      ttlSeconds: 900,
    });
    if (typeof upload.url !== 'string') {
      throw new ProviderFailed('Boat answered without where to put the machine program');
    }
    await boat.put(upload.url, program);
    await write(`${HERE}/boot`, BOAT_BOOT);
    await write(`${HERE}/acentric-machine.service`, BOAT_UNIT);

    // 3. Installed, and checked.
    step();
    print('\n--- the machine program is installed ---\n');
    const installed = await run(INSTALL, 300);
    print((installed.stdout ?? '') + (installed.stderr ?? ''));
    if (installed.exitCode !== 0) {
      throw new TemplateFailed(
        installed.timedOut === true
          ? 'Installing the machine program took too long'
          : 'The machine program could not be installed',
      );
    }

    // 4. Saved.
    step();
    const path = `/saved-snapshots/${encodeURIComponent(build.name)}`;
    await boat.call('POST', '/saved-snapshots', { sandboxId: id, name: build.name });
    for (const until = Date.now() + boat.saveMs; ;) {
      await wait(boat.pollMs);
      // Stopped while it is saved: what Boat goes on to save is deleted with the template.
      step();
      const saved = (await boat.call<Saved>('GET', path)).snapshot;
      if (saved?.status === 'ready') return;
      if (saved?.status === 'failed') {
        throw new TemplateFailed(
          `Boat could not save the disk${typeof saved.error === 'string' ? `: ${saved.error}` : ''}`,
        );
      }
      if (Date.now() >= until) throw new TemplateFailed('Boat took too long to save the disk');
    }
  } finally {
    await boat
      .call('DELETE', one, undefined, { 'x-ascii-confirm-delete': id })
      .catch(() => undefined);
  }
}
