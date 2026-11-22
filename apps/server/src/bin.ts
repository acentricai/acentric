#!/usr/bin/env node
// The server's program. It reads its settings from the environment (see `settings.ts`),
// starts, and says where it listens. Told to stop, it finishes what it is in the middle of.

import { readFileSync } from 'node:fs';

import { InvalidSettings, readSettings } from './settings.ts';
import { resetLink, start } from './start.ts';

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

// `acentric-server reset-link <email>`: a link that sets a person's password again, for one
// who can run this on the server itself. It is how an owner who is locked out gets back in.
if (process.argv[2] === 'reset-link') {
  const email = process.argv[3];
  if (email === undefined) {
    console.error('Say whose password: acentric-server reset-link <email>');
    process.exit(2);
  }
  try {
    const made = await resetLink(settings, email);
    console.log(made.link);
    console.log(`It works once, until ${new Date(made.expiresAt).toISOString()}.`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

let started;
try {
  started = await start(settings, { version });
} catch (error) {
  // Said in a line: what was wrong is the message, not where in the code it was found.
  console.error(
    `The server was not started: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
console.log(`acentric-server ${version} listening on ${started.server.url}`);
if (started.recovered > 0) {
  console.log(`picked up ${String(started.recovered)} actors with something owed`);
}
if (settings.secretKeys === undefined) {
  console.log('ACENTRIC_SECRET_KEY is not set: agents can be given no secrets');
}
if (started.setupLink !== undefined) {
  // Nobody can sign in yet. Whoever opens this makes themselves the owner.
  console.log(`setup ${started.setupLink}`);
  console.log('This link makes the owner of this server. It works once, for a week.');
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
