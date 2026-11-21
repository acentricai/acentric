#!/usr/bin/env node
// The server's command. It only says what version it is, until the server is written.

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

console.log(`acentric-server ${version}`);
