// The versions two sides must agree on before they talk.
//
// The API's version is in its paths. The bundle protocol is what the engine and an agent's
// deployed code say to each other: a deploy names the protocol its code was built for, and an
// engine runs the protocols it lists here.
//
// How long an engine keeps running an old protocol, and what becomes of the actors on a
// deployment it no longer runs, is part of how deployments are upgraded, which is not decided.
// Until it is, an engine runs every protocol there has been.

/** The API's version: the first part of every path, as in `/v1/actors`. */
export const API_VERSION = 'v1';

/** The bundle protocol an agent built today speaks. */
export const BUNDLE_PROTOCOL = 1;

/** The bundle protocols this engine runs. */
export const SUPPORTED_BUNDLE_PROTOCOLS: readonly number[] = [1];

/** Whether this engine runs code built for bundle protocol `version`. */
export function supportsBundleProtocol(version: number): boolean {
  return SUPPORTED_BUNDLE_PROTOCOLS.includes(version);
}

/**
 * The header an engine that hands out the `acentric` command says which one in: the SHA-256
 * of the file, in hex. The command compares it with its own, and so knows when the engine has
 * another version of it.
 */
export const COMMAND_HEADER = 'x-acentric-command';
