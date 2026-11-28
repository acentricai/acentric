// Claude, on a Claude plan: the calls of an account's actors are made by the Claude Agent SDK,
// with Claude Code signed in to the account's plan (see `sign-in.ts` and `sessions.ts`).
//
// It is not one of the providers an engine has without being asked: the SDK and Claude Code
// are not part of this package or of the server's image. A server started with Claude installs
// the SDK, and makes this provider with its module and its `claude` program.

import type { ModelInfo } from '../../catalog.ts';
import { ModelFailure } from '../../failure.ts';
import { outputText, reasoningSummary, toolCalls } from '../../anthropic/read.ts';
import { ANTHROPIC_MODELS } from '../anthropic.ts';
import { onlyOptions, withoutTypes } from '../../provider.ts';
import type { Provider } from '../../provider.ts';
import { ClaudeSessions, LABEL, PROVIDER } from './sessions.ts';
import { claudeSignIn, homeOf } from './sign-in.ts';
import type { ClaudeSdk } from './sdk.ts';

export type { ClaudeSdk } from './sdk.ts';

/** Two minutes: a session at rest is resumed at its next call in a second or two. */
const IDLE_MS = 2 * 60 * 1000;
/** The memory a session's process is taken to hold, for how many the host can keep. */
const SESSION_BYTES = 600 * 1024 * 1024;

// Anthropic's models, without prices: a plan's calls are not paid by the token.
const MODELS: readonly ModelInfo[] = ANTHROPIC_MODELS.map(
  ({ pricing: _pricing, ...model }) => model,
);

export type ClaudeOptions = {
  /** The Claude Agent SDK's module. */
  readonly sdk: ClaudeSdk;
  /** The `claude` program the SDK runs. */
  readonly binary: string;
  /** The provider's own folder: the accounts' folders, and where sessions run. */
  readonly home: string;
  /** The environment Claude Code is given what it needs of. */
  readonly env?: { readonly [name: string]: string | undefined };
  /** How long a session with nothing to do is kept before its process is stopped. */
  readonly idleMs?: number;
  /** How many sessions' processes are kept at once. */
  readonly maxSessions?: number;
  /** How much memory the host has, for how many sessions it keeps without `maxSessions`. */
  readonly memory?: number;
  /** Where what Claude Code said of a session that failed is written. */
  readonly report?: (line: string) => void;
};

/** Claude, on the plans of accounts signed in with Claude Code. */
export function claudeProvider(options: ClaudeOptions): Provider {
  const program = {
    binary: options.binary,
    accounts: `${options.home}/accounts`,
    env: options.env ?? process.env,
  };
  const sessions = new ClaudeSessions({
    sdk: options.sdk,
    program,
    workDir: `${options.home}/work`,
    idleMs: options.idleMs ?? IDLE_MS,
    maxSessions:
      options.maxSessions ?? Math.max(2, Math.floor((options.memory ?? 0) / SESSION_BYTES)),
    report: options.report ?? ((line) => console.error(line)),
  });
  return {
    id: PROVIDER,
    label: LABEL,
    credentials: ['local_sign_in'],
    models: MODELS,
    defaultModel: 'claude-opus-5-5',
    bindsReasoning: true,
    plan: true,
    // Claude Code keeps its own copy of the conversation, and compacts that.
    compacts: 'inside',
    signIn: claudeSignIn(program),

    parseOptions(given) {
      const asked = onlyOptions(given, ['webSearch'], LABEL);
      const search = asked['webSearch'];
      if (search === undefined) return {};
      if (search !== true) {
        throw new TypeError(
          `${LABEL}: webSearch is true, and Claude Code's search takes no list of sites`,
        );
      }
      return { webSearch: true };
    },

    runner(settings) {
      const home = homeOf(settings.credential);
      const { logs } = settings;
      if (logs === undefined)
        throw new TypeError('Claude keeps a log of each conversation, and was given none');
      return {
        run: async (step, signal) => {
          if (step.session === undefined) {
            throw new ModelFailure(
              'A call of Claude names no conversation to keep a session of',
              'invalid_request',
              { provider: PROVIDER },
            );
          }
          return sessions.run(step, home, logs(step.session), signal);
        },
      };
    },

    withoutReasoning: (message) => withoutTypes(message, ['thinking', 'redacted_thinking']),

    read: (message) => ({
      text: outputText(message.content),
      reasoning: reasoningSummary(message.content),
      toolCalls: toolCalls(message.content),
    }),

    async close() {
      sessions.close();
    },
  };
}
