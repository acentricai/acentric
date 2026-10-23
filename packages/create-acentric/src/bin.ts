#!/usr/bin/env node
// create-acentric: what `npm create acentric` runs.
//
//   npm create acentric@latest my-agent
//   pnpm create acentric my-agent --no-install

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import {
  CreateError,
  createProject,
  detectPackageManager,
  runCommand,
  TEMPLATES,
} from './create.js';
import type { PackageManager } from './create.js';

const USAGE = `usage: npm create acentric [dir] [options]

options:
  --template NAME   the template: ${TEMPLATES.join(', ')} (default: minimal)
  --pm NAME         npm, pnpm, yarn or bun (default: the one that ran this)
  --no-install      do not install dependencies
  --no-git          do not run git init
  --local DIR       take the acentric packages from a checkout of the acentric repository
  -y, --yes         ask nothing, using the defaults`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      template: { type: 'string', default: 'minimal' },
      pm: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'no-git': { type: 'boolean', default: false },
      local: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const manager = toManager(values.pm) ?? detectPackageManager();
  const interactive = process.stdin.isTTY && !values.yes;
  const prompt = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    let dir = positionals[0];
    if (dir === undefined) {
      dir =
        prompt === null
          ? 'my-agent'
          : (await prompt.question('Project folder: (my-agent) ')).trim() || 'my-agent';
    }
    let install = !values['no-install'];
    if (install && prompt !== null) {
      const answer = (await prompt.question(`Install dependencies with ${manager}? (Y/n) `))
        .trim()
        .toLowerCase();
      install = answer === '' || answer.startsWith('y');
    }
    prompt?.close();

    const created = await createProject({
      dir,
      template: values.template,
      packageManager: manager,
      git: !values['no-git'],
      install,
      ...(values.local === undefined ? {} : { local: values.local }),
      log: (line) => process.stdout.write(`${line}\n`),
    });
    const run = runCommand(manager);
    process.stdout.write(
      `\ncreated ${created.name} in ${created.dir}\n\nnext:\n  cd ${dir}\n${install ? '' : `  ${manager} install\n`}  ${run} dev\n`,
    );
    return 0;
  } finally {
    prompt?.close();
  }
}

function toManager(value: string | undefined): PackageManager | undefined {
  if (value === undefined) return undefined;
  if (value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun') return value;
  throw new CreateError(`--pm must be npm, pnpm, yarn or bun, not ${value}`);
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `create-acentric: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
