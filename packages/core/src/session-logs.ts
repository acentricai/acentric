// What a model provider keeps of an actor's conversation beside the engine's, kept in the
// store. A step names its conversation by the actor's ID, so that is what a log is found by.

import type { SessionLog, SessionLogs } from '@acentric/ai';
import type { ActorId } from '@acentric/protocol';

import type { Store } from './store.ts';

/** The logs of the actors' conversations, in `store`. */
export function sessionLogs(store: Store): SessionLogs {
  return (session: string): SessionLog => {
    if (!session.startsWith('act_')) {
      throw new TypeError(`A session log is an actor's, and ${session} is no actor's ID`);
    }
    const actor = session as ActorId;
    return {
      read: (stream) => store.readSessionLog(actor, stream),
      append: (stream, entries) => store.appendSessionLog(actor, stream, entries),
      replace: (stream, entries) => store.replaceSessionLog(actor, stream, entries),
      streams: () => store.sessionLogStreams(actor),
      clear: () => store.clearSessionLog(actor),
    };
  };
}
