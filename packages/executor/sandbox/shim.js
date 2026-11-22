// The main module of every agent loaded in workerd. It imports the deployment's code as
// `./__agent__.js`, finds what the framework put in it, and answers the host worker's calls:
// `describe`, what the code says it is, and `call`, one function of it by its path.
//
// The code that answers is the framework's own, inside the agent's code. So this module knows
// nothing of agents but where that is found.

import { WorkerEntrypoint } from 'cloudflare:workers';

// A namespace import: code with no default export still loads, and is told so.
import * as bundle from './__agent__.js';

// Where a bundle's entry is found on its default export (`BUNDLE_ENTRY` of the protocol).
const ENTRY = Symbol.for('acentric.bundle');

function entryOf() {
  const exported = 'default' in bundle ? bundle.default : undefined;
  const entry = typeof exported === 'object' && exported !== null ? exported[ENTRY] : undefined;
  if (
    entry === undefined ||
    entry === null ||
    typeof entry.describe !== 'function' ||
    typeof entry.call !== 'function'
  ) {
    throw new Error('The code exports no agent: its default export is to be `new Agent(…)`');
  }
  return entry;
}

/** The value the engine answered, or its error, thrown. */
function answered(answer) {
  if (answer.error !== undefined) {
    const error = new Error(answer.error.message);
    error.name = answer.error.name;
    throw error;
  }
  return answer.value;
}

export default class Shim extends WorkerEntrypoint {
  /** Answers once the module has loaded: the host loads agents in turn with this. */
  ready() {
    return true;
  }

  /** `{ protocol, definition }`, or `{ error }` saying why the code is not an agent. */
  describe() {
    try {
      const entry = entryOf();
      return { protocol: entry.protocol, definition: entry.describe() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Calls the function `path` names, and gives how the call ended. `host` belongs to this
   * call alone: its `secret` asks the engine for a secret of the agent's.
   */
  call(path, argument, context, host) {
    return entryOf().call(path, argument, context, {
      secret: async (name) => answered(await host.secret(String(name))),
    });
  }
}
