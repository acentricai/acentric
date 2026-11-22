// The workerd config of one process: the host worker on a loopback port the system picks, the
// worker loader that holds agents' code, and the network agents' code reaches the world
// through.

import { isIP } from 'node:net';

/**
 * Where agents' code may connect.
 *
 *   public   public addresses only, checked after a name is resolved, and the private
 *            addresses and ranges in `allow` besides. It is the default: a tool often fetches
 *            an address the model chose, which is then kept from the engine's own machine,
 *            its private network and a cloud's metadata address.
 *   any      anywhere, this machine and its private network too.
 */
export type Network =
  { readonly reach: 'public'; readonly allow?: readonly string[] } | { readonly reach: 'any' };

/** An address or a range as workerd takes one: `10.0.0.0/8`, `10.1.2.3`, `fd00::/8`. */
function rangeOf(given: string): string {
  const [address, bits, ...rest] = given.trim().split('/');
  const family = isIP(address ?? '');
  const most = family === 4 ? 32 : 128;
  const prefix = bits === undefined ? most : Number(bits);
  const whole = bits === undefined || /^\d{1,3}$/.test(bits);
  if (family === 0 || rest.length > 0 || !whole || prefix > most) {
    throw new TypeError(
      `${JSON.stringify(given)} is not an address or a range of addresses, such as 10.0.0.0/8 or 10.1.2.3`,
    );
  }
  return `${String(address)}/${String(prefix)}`;
}

/** The networks workerd lets agents' code reach, by its names for them and by range. */
export function allowedNetworks(network: Network): string[] {
  if (network.reach === 'any') return ['public', 'private', 'local'];
  return ['public', ...(network.allow ?? []).map(rangeOf)];
}

export function renderConfig(options: {
  readonly network: Network;
  readonly token: string;
  readonly compatibilityDate: string;
  /** How many agents' code one process loads at once. */
  readonly loadConcurrency: number;
}): string {
  const text = (value: string): string => JSON.stringify(value);
  const allow = allowedNetworks(options.network).map(text).join(', ');
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "host", worker = .host),
    (name = "internet", network = (allow = [${allow}], deny = [], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "engine", address = "127.0.0.1:0", http = (), service = "host")],
);

const host :Workerd.Worker = (
  modules = [
    (name = "host.js", esModule = embed "host.js"),
    (name = "shim.txt", text = embed "shim.js"),
  ],
  compatibilityDate = ${text(options.compatibilityDate)},
  bindings = [
    (name = "LOADER", workerLoader = (id = "agents")),
    (name = "NET", service = "internet"),
    (name = "TOKEN", text = ${text(options.token)}),
    (name = "COMPATIBILITY_DATE", text = ${text(options.compatibilityDate)}),
    (name = "LOAD_CONCURRENCY", text = ${text(String(options.loadConcurrency))}),
  ],
  globalOutbound = "internet",
);
`;
}
