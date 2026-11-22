#!/usr/bin/env node
// The server's program. It reads its settings from the environment (see `settings.ts`),
// starts, and says where it listens. Told to stop, it finishes what it is in the middle of.

import { readFileSync } from 'node:fs';

import { InvalidSettings, readSettings } from './settings.ts';
import { start } from './start.ts';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

if (process.argv.includes('--version')) {
  console.log(`acentric-server ${version}`);
  process.exit(0);
}

let settings;
try {
  settings = readSettings(process.env);
} catch (error) {
  if (!(error instanceof InvalidSettings)) throw error;
  console.error(`The server was not started: ${error.message}`);
  process.exit(2);
}

const started = await start(settings, { version });
console.log(`acentric-server ${version} listening on ${started.server.url}`);
if (started.recovered > 0) {
  console.log(`picked up ${String(started.recovered)} actors with something owed`);
}
if (settings.secretKeys === undefined) {
  console.log('ACENTRIC_SECRET_KEY is not set: agents can be given no secrets');
}
if (started.firstKey !== undefined) {
  // Nothing could call the server otherwise. It is shown here once, and kept nowhere.
  console.log(`key ${started.firstKey}`);
  console.log('This key may do everything, and is not shown again. Keep it somewhere safe.');
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('stopping');
    void started.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
}
