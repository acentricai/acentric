// Claude, on Claude plans, for a server started with ACENTRIC_CLAUDE=on: nothing of it is here
// otherwise. The Claude Agent SDK and its Claude Code are not in the server's image. The first
// time the server starts with Claude, it installs the SDK from npm into a folder of its data,
// and from then on loads it from there.
//
// What is installed is exactly what this version was built and tested with: `claude-sdk/`
// beside the server holds the SDK's version and a lockfile with every package's version and
// hash, Claude Code's own among them, and npm installs from that and checks each. A version of
// the server with another is what installs another; Claude Code does not update itself.
//
// The SDK's folder holds Claude Code, as Anthropic publishes it, for this system alone. The
// accounts' sign-ins are kept by Claude Code in folders of their own beside it.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constrainedMemory, platform, arch, report } from 'node:process';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Provider } from '@acentric/ai';
import { claudeProvider } from '@acentric/ai/claude';
import type { ClaudeSdk } from '@acentric/ai/claude';

import type { Logger } from './log.ts';
import type { ClaudeSettings } from './settings.ts';

const SDK = '@anthropic-ai/claude-agent-sdk';

/** What this server installs: the SDK's version, and the lockfile of all it installs. */
const SHIPPED = fileURLToPath(new URL('../claude-sdk/', import.meta.url));

/** The version of the Claude Agent SDK this server is built and tested with. */
export const CLAUDE_SDK_VERSION = (
  JSON.parse(readFileSync(join(SHIPPED, 'package.json'), 'utf8')) as {
    dependencies: { [name: string]: string };
  }
).dependencies[SDK] as string;

/** How long installing the SDK may take: it is a few hundred megabytes. */
const INSTALL_MS = 10 * 60 * 1000;

/** The Claude Agent SDK could not be installed or loaded. */
export class ClaudeUnavailable extends Error {
  override readonly name = 'ClaudeUnavailable';
}

/** Whether a folder has what this server installs: its lockfile, and the SDK's version. */
function installedHere(dir: string): boolean {
  try {
    return (
      readFileSync(join(dir, 'package-lock.json'), 'utf8') ===
        readFileSync(join(SHIPPED, 'package-lock.json'), 'utf8') &&
      installedIn(dir) === CLAUDE_SDK_VERSION
    );
  } catch {
    return false;
  }
}

/** The version of the SDK installed in a folder, or undefined when none is. */
function installedIn(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'node_modules', SDK, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Installs the SDK, as this server's lockfile has it, into a folder of its own. */
async function install(dir: string, logger: Logger): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(join(SHIPPED, file), join(dir, file));
  }
  logger.info(`installing the Claude Agent SDK ${CLAUDE_SDK_VERSION} from npm`, { dir });
  const output = await new Promise<string>((resolve, reject) => {
    // Each package at its version in the lockfile, checked against its hash there, and what
    // was installed before taken away first. No script of any package is run.
    const child = spawn(
      'npm',
      ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );
    let said = '';
    child.stdout.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (said += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ClaudeUnavailable(`npm could not be run: ${error.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(said);
      else
        reject(new ClaudeUnavailable(`npm could not install the SDK: ${said.trim().slice(-2000)}`));
    });
  });
  if (installedIn(dir) !== CLAUDE_SDK_VERSION) {
    throw new ClaudeUnavailable(
      `npm installed no ${SDK} ${CLAUDE_SDK_VERSION}: ${output.trim().slice(-500)}`,
    );
  }
}

/** Claude Code as the SDK finds it: the package of this system's. */
function binaryOf(sdkEntry: string): string {
  const require = createRequire(sdkEntry);
  const musl =
    platform === 'linux' &&
    (report.getReport() as { header?: { glibcVersionRuntime?: string } }).header
      ?.glibcVersionRuntime === undefined;
  const candidates =
    platform === 'linux'
      ? musl
        ? [`${SDK}-linux-${arch}-musl`, `${SDK}-linux-${arch}`]
        : [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`]
      : [`${SDK}-${platform}-${arch}`];
  for (const candidate of candidates) {
    try {
      const path = require.resolve(`${candidate}/claude${platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this system: the next.
    }
  }
  throw new ClaudeUnavailable(`Claude Code is not installed for ${platform}-${arch}`);
}

/** How much memory the server may use: its container's, where it has one. */
function memoryOf(): number {
  const limit = constrainedMemory();
  return limit > 0 && limit < totalmem() ? limit : totalmem();
}

/**
 * The Claude provider, with the SDK installed if it is not, or at another version. Throws a
 * `ClaudeUnavailable`, with why, when it cannot be.
 */
export async function claude(
  settings: ClaudeSettings,
  data: string,
  logger: Logger,
): Promise<Provider> {
  const home = join(data, 'claude');
  const sdkDir = settings.sdk ?? join(home, 'sdk');
  const installed = installedIn(sdkDir);
  if (settings.sdk !== undefined && installed === undefined) {
    throw new ClaudeUnavailable(`ACENTRIC_CLAUDE_SDK has no ${SDK} installed in it: ${sdkDir}`);
  }
  if (settings.sdk === undefined && !installedHere(sdkDir)) await install(sdkDir, logger);
  let entry: string;
  let sdk: ClaudeSdk;
  try {
    entry = createRequire(join(sdkDir, 'package.json')).resolve(SDK);
    sdk = (await import(pathToFileURL(entry).href)) as ClaudeSdk;
  } catch (error) {
    throw new ClaudeUnavailable(
      `The Claude Agent SDK could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof sdk.query !== 'function')
    throw new ClaudeUnavailable('The Claude Agent SDK has no query');
  const binary = binaryOf(entry);
  mkdirSync(join(home, 'accounts'), { recursive: true, mode: 0o700 });
  logger.info('Claude is on, with the Claude Agent SDK', {
    version: installedIn(sdkDir) ?? 'unknown',
    sdk: dirname(entry),
  });
  return claudeProvider({
    sdk,
    binary,
    home,
    idleMs: settings.idleMs,
    memory: memoryOf(),
    ...(settings.maxSessions === undefined ? {} : { maxSessions: settings.maxSessions }),
    report: (line) => logger.warn(line, { from: 'claude' }),
  });
}
