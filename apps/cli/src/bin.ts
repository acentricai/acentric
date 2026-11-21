#!/usr/bin/env node
// The acentric command. It only says what version it is, until its commands are written.

import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

console.log(`acentric ${version}`);
