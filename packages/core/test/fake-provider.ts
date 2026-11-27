// A provider of sandboxes, for tests of the engine's side: it makes nothing anywhere, and
// keeps what it was asked. A sandbox it "starts" is a daemon of the tests' own (see
// `fake-daemon.ts`), which enrols with what the engine gave the sandbox and connects.

import type { MachineId, SandboxState } from '@acentric/protocol';

import type { Machines } from '../src/machines.ts';
import { ProviderFailed, providerFailure } from '../src/sandbox.ts';
import type {
  NewSandbox,
  ProviderSandbox,
  SandboxAccount,
  SandboxProvider,
  TemplateBuild,
} from '../src/sandbox.ts';
import { FakeDaemon } from './fake-daemon.ts';

type Kept = {
  readonly id: string;
  state: SandboxState;
  readonly labels: { readonly [name: string]: string };
  readonly asked: NewSandbox;
  readonly daemon: FakeDaemon;
  enrolled: boolean;
};

export class FakeProvider implements SandboxProvider {
  readonly kind: string;
  readonly label: string;
  readonly credential: 'api_key' | 'none';
  readonly idle: 'provider' | 'engine';
  /** The keys it takes, each with whose it is. */
  readonly keys = new Map<string, string>([['good-key', 'dev@example.com']]);
  /** Everything it was asked, in order: `create sbx-1`, `keepFor sbx-1 3600`. */
  readonly calls: string[] = [];
  readonly sandboxes = new Map<string, Kept>();
  /** The engine's machines: with them a sandbox that starts has a daemon that connects. */
  machines: Machines | undefined;
  /** Whether a sandbox that is made, or started, has its daemon connect. */
  boots = true;
  /** Why nothing can be made, as a server that was not set up for it says. */
  missing: string | undefined;
  /** Fails a call, when it gives what with. */
  fail: (call: string, id: string) => Error | undefined = () => undefined;
  /** Takes its time over a call, when it gives how. */
  wait: (call: string, id: string) => Promise<void> = async () => {};
  /** Where its sandboxes reach a server. */
  serverFor?: (url: string) => string;
  /** How a template's build goes, when it is asked for one: it prints, and it ends. */
  build: (asked: TemplateBuild) => Promise<void> = async (asked) => {
    asked.output('built\n');
  };
  /** The templates it has saved, by name. */
  readonly saved = new Set<string>();
  #made = 0;

  constructor(
    given: {
      readonly kind?: string;
      readonly label?: string;
      readonly credential?: 'api_key' | 'none';
      readonly idle?: 'provider' | 'engine';
    } = {},
  ) {
    this.kind = given.kind ?? 'fake';
    this.label = given.label ?? 'Fake';
    this.credential = given.credential ?? 'api_key';
    this.idle = given.idle ?? 'provider';
  }

  sizeProblem(vcpu: number, memoryGB: number): string | undefined {
    return memoryGB === vcpu * 2
      ? undefined
      : `${this.label} has no ${String(vcpu)} vCPU / ${String(memoryGB)} GB size`;
  }

  unavailable(): string | undefined {
    return this.missing;
  }

  /** The calls of one kind, in order, without its name. */
  asked(call: string): string[] {
    return this.calls
      .filter((one) => one === call || one.startsWith(`${call} `))
      .map((one) => one.slice(call.length + 1));
  }

  /** The one sandbox there is. */
  get only(): Kept {
    const [one] = [...this.sandboxes.values()];
    if (one === undefined) throw new Error('It has made no sandbox');
    return one;
  }

  /** Has a sandbox's daemon connect: it enrols first, the first time. */
  async boot(id: string): Promise<void> {
    const kept = this.sandboxes.get(id);
    if (kept === undefined || this.machines === undefined) return;
    const given = JSON.parse(kept.asked.provision) as { id: MachineId; token: string };
    if (!kept.enrolled) {
      await this.machines.enrol(given.id, { token: given.token, publicKey: kept.daemon.publicKey });
      kept.enrolled = true;
    }
    await kept.daemon.connect(this.machines, given.id);
  }

  /** Stops a sandbox as the provider itself does when its timer runs out. */
  expire(id: string): void {
    const kept = this.sandboxes.get(id);
    if (kept === undefined) return;
    kept.state = 'stopped';
    kept.daemon.drop();
  }

  account(credential: string | null): SandboxAccount {
    const said = async (call: string, id = '', more = ''): Promise<void> => {
      this.calls.push([call, id, more].filter((part) => part !== '').join(' '));
      await this.wait(call, id);
      const failure = this.fail(call, id);
      if (failure !== undefined) throw failure;
      if (this.credential === 'api_key' && !this.keys.has(credential ?? '')) {
        throw providerFailure(this.label, 401);
      }
    };
    const kept = (id: string): Kept => {
      const one = this.sandboxes.get(id);
      if (one === undefined) throw providerFailure(this.label, 404, 'no such sandbox');
      return one;
    };
    const view = (one: Kept): ProviderSandbox => ({
      id: one.id,
      state: one.state,
      labels: one.labels,
    });
    return {
      whoami: async () => {
        await said('whoami');
        return this.keys.get(credential ?? '') ?? null;
      },
      create: async (asked) => {
        await said('create', asked.name);
        this.#made += 1;
        const one: Kept = {
          id: `sbx-${String(this.#made)}`,
          state: this.boots ? 'running' : 'starting',
          labels: asked.labels,
          asked,
          daemon: new FakeDaemon(),
          enrolled: false,
        };
        this.sandboxes.set(one.id, one);
        if (this.boots) await this.boot(one.id);
        return view(one);
      },
      state: async (id) => {
        await said('state', id);
        return this.sandboxes.get(id)?.state ?? 'gone';
      },
      ...(this.idle === 'provider'
        ? {
            keepFor: async (id: string, idleSeconds: number) => {
              await said('keepFor', id, String(idleSeconds));
              kept(id);
            },
          }
        : {
            stop: async (id: string) => {
              await said('stop', id);
              const one = kept(id);
              one.state = 'stopped';
              one.daemon.drop();
            },
          }),
      start: async (id, idleSeconds) => {
        await said('start', id, String(idleSeconds));
        const one = kept(id);
        if (one.state === 'stopping') {
          throw new ProviderFailed(`${this.label} answered 409: it is still stopping`, {
            status: 409,
            reason: 'busy',
          });
        }
        if (one.state === 'starting') return false;
        one.state = 'running';
        if (this.boots) await this.boot(id);
        return true;
      },
      delete: async (id) => {
        await said('delete', id);
        this.sandboxes.get(id)?.daemon.drop();
        this.sandboxes.delete(id);
      },
      buildTemplate: async (asked) => {
        await said('buildTemplate', asked.name);
        await this.build(asked);
        this.saved.add(asked.name);
      },
      deleteTemplate: async (name) => {
        await said('deleteTemplate', name);
        this.saved.delete(name);
      },
      list: async (label, value) => {
        await said('list', `${label}=${value}`);
        return new Map(
          [...this.sandboxes.values()]
            .filter((one) => one.labels[label] === value)
            .map((one) => [one.id, view(one)]),
        );
      },
    };
  }
}
