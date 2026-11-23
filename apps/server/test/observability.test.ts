// Running a server: a line of its log for each request and each turn, never a secret in one;
// its metrics on a port of their own; and /health that says when it is not to be sent requests.

import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { createClient } from '@acentric/client';
import type { ActorId } from '@acentric/protocol';

import { restore } from '../src/backups/archive.ts';
import { createLogger } from '../src/log.ts';
import { readSettings, start } from '../src/index.ts';
import {
  ADMIN_KEY,
  MODEL_KEY,
  ORDERS_SECRET,
  OWNER,
  SECRET_KEY,
  providers,
  turn,
} from './releases/seed.ts';
import type { Facts } from './releases/seed.ts';

const RELEASE = join(import.meta.dirname, 'releases', '0.15.0');
const folders: string[] = [];
afterAll(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

describe('a server that is run', () => {
  it('logs each request and turn, counts them, and says when it is stopping', async () => {
    const data = await mkdtemp(join(tmpdir(), 'acentric-observed-'));
    folders.push(data);
    const settings = readSettings({
      ACENTRIC_PORT: '0',
      ACENTRIC_METRICS_PORT: '0',
      ACENTRIC_DATA: data,
      ACENTRIC_SECRET_KEY: SECRET_KEY,
      ACENTRIC_ADMIN_KEY: ADMIN_KEY,
      ACENTRIC_CODE_PROCESSES: '1',
    });
    await restore({
      data,
      input: createReadStream(`${RELEASE}.tar.gz`).pipe(createGunzip()),
      keys: Object.keys(settings.secretKeys?.keys ?? {}),
    });
    const facts = (
      (await import(`${RELEASE}.json`, { with: { type: 'json' } })) as { default: Facts }
    ).default;
    const actor = facts.actors[0]?.id as ActorId;

    const lines: string[] = [];
    const server = await start(settings, {
      version: '0.16.0',
      providers: providers(),
      logger: createLogger({ format: 'json', level: 'debug', write: (line) => lines.push(line) }),
    });
    try {
      const admin = createClient({ baseUrl: server.server.url, token: ADMIN_KEY });
      await turn(admin, actor, { text: 'What happened to order 42?' });
      const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

      // A line for each request, by its route, with whose it was.
      expect(said).toContainEqual(
        expect.objectContaining({
          level: 'info',
          msg: 'request',
          method: 'POST',
          route: 'inputs.send',
          status: 202,
          // The key the server was given, by its ID: never the key.
          by: expect.stringMatching(/^key_/),
        }),
      );
      // And for the turn, which ended well, with how long it took.
      expect(said).toContainEqual(
        expect.objectContaining({ msg: 'turn ended', actor, end: 'ok', ms: expect.any(Number) }),
      );
      expect(said).toContainEqual(
        expect.objectContaining({
          msg: 'tool called',
          tool: 'lookup_order',
          kind: 'agent',
          outcome: 'ok',
        }),
      );
      // Never a secret.
      for (const secret of [ADMIN_KEY, SECRET_KEY, ORDERS_SECRET, MODEL_KEY, OWNER.password]) {
        expect(lines.join('\n')).not.toContain(secret);
      }

      // The metrics, on their own port, and not on the API's.
      const url = server.metricsUrl as string;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/metrics$/);
      const metrics = await (await fetch(url)).text();
      for (const line of [
        'acentric_build_info{version="0.16.0"} 1',
        'acentric_turns_started_total 1',
        'acentric_turns_ended_total{end="ok"} 1',
        'acentric_model_calls_total{provider="fake",model="fake-1",kind="turn",outcome="ok"} 2',
        'acentric_tool_calls_total{kind="agent",outcome="ok"} 1',
        'acentric_http_requests_total{route="inputs.send",method="POST",status="202"} 1',
        'acentric_actors_working 0',
      ]) {
        expect(metrics).toContain(line);
      }
      expect(metrics).toMatch(/^acentric_database_bytes\{file="database"\} [1-9]\d*$/m);
      expect(metrics).toMatch(/^acentric_code_processes\{state="live"\} [1-9]\d*$/m);
      expect(metrics).toMatch(/^acentric_turn_duration_seconds_count\{end="ok"\} 1$/m);
      expect(metrics).toContain('# TYPE acentric_http_request_duration_seconds histogram');
      expect((await fetch(url.replace('/metrics', '/other'))).status).toBe(404);
      expect((await fetch(`${server.server.url}/metrics`)).status).toBe(404);

      // Ready, then stopping: /health says not to send it more, /health/live that it is there.
      expect(await (await fetch(`${server.server.url}/health`)).json()).toEqual({
        ok: true,
        version: '0.16.0',
      });
      server.drain();
      const draining = await fetch(`${server.server.url}/health`);
      expect(draining.status).toBe(503);
      expect(await draining.json()).toEqual({
        ok: false,
        version: '0.16.0',
        problems: ['it is stopping'],
      });
      expect((await fetch(`${server.server.url}/health/live`)).status).toBe(200);
    } finally {
      await server.close();
    }
  }, 120_000);

  it('serves no metrics without a port for them', async () => {
    const data = await mkdtemp(join(tmpdir(), 'acentric-unobserved-'));
    folders.push(data);
    const server = await start(
      readSettings({ ACENTRIC_PORT: '0', ACENTRIC_DATA: data, ACENTRIC_CODE_PROCESSES: '1' }),
      { version: '0.16.0', log: () => {} },
    );
    try {
      expect(server.metricsUrl).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 60_000);
});
