// What the server connects to for an agent, from its own process: the MCP servers an agent
// names. It reaches what agents' code may reach (`Network`), and no more: with `public`, a
// public address, or one of the private ones allowed, checked for every connection as it is
// made, after its name is resolved, and for every address a redirect sends it to.

import { lookup as resolve } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

import type { Network } from './isolate/config.ts';

/** Where an agent may not reach, unless it is allowed: this machine, its networks, and clouds' own. */
const NOT_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carriers' NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and clouds' metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
] as const) {
  NOT_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: an IPv4 address of any kind
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  NOT_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** The IPv4 address an IPv6 one is, when it is one written as IPv6 (::ffff:10.0.0.1). */
function v4Of(address: string): string | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1];
}

/** Whether an agent may reach an address, by `network`. */
export function reachable(network: Network, address: string): boolean {
  if (network.reach === 'any') return true;
  const v4 = v4Of(address);
  const plain = v4 ?? address;
  const family = isIP(plain) === 4 ? 'ipv4' : 'ipv6';
  if (isIP(plain) === 0) return false;
  if (!NOT_PUBLIC.check(plain, family)) return true;
  const allowed = new BlockList();
  for (const range of network.allow ?? []) {
    const [base = '', bits] = range.trim().split('/');
    const kind = isIP(base) === 4 ? 'ipv4' : 'ipv6';
    if (isIP(base) === 0) continue;
    const prefix = bits === undefined ? (kind === 'ipv4' ? 32 : 128) : Number(bits);
    allowed.addSubnet(base, prefix, kind);
  }
  return allowed.check(plain, family);
}

/** Refused: the address is not one an agent may reach. */
export class Unreachable extends Error {
  override readonly name = 'Unreachable';
  constructor(host: string) {
    super(
      `${host} is not an address agents may reach: ACENTRIC_AGENT_NETWORK keeps them to public addresses, and to the private ones ACENTRIC_AGENT_NETWORK_ALLOW names`,
    );
  }
}

/** How many redirects are followed, each to an address checked as the first was. */
const REDIRECTS = 5;

/** A `fetch` that reaches only what an agent may, by `network`. */
export function fetchWithin(network: Network): typeof fetch {
  if (network.reach === 'any') return fetch;
  const dispatcher = new Agent({
    connect: {
      // Every connection a name makes: only the addresses an agent may reach are used, so a
      // name that resolves anew when it is connected to is checked as it is connected to.
      lookup: (hostname, options, callback) => {
        resolve(hostname, { ...options, all: true }, (error, found) => {
          if (error !== null) {
            callback(error, '', 0);
            return;
          }
          const usable = (found as LookupAddress[]).filter((one) =>
            reachable(network, one.address),
          );
          const [first] = usable;
          if (first === undefined) {
            callback(new Unreachable(hostname), '', 0);
            return;
          }
          if ((options as { all?: boolean }).all === true) {
            (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(
              null,
              usable,
            );
          } else callback(null, first.address, first.family);
        });
      },
    },
  });
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const first = new Request(input, init);
    // Read once, to be sent again where a redirect keeps it: what MCP sends is small.
    let body: ArrayBuffer | undefined = first.body === null ? undefined : await first.arrayBuffer();
    let url = first.url;
    let method = first.method;
    for (let hop = 0; ; hop += 1) {
      const { hostname } = new URL(url);
      const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
      // An address in the URL itself is connected to as it is, without a name to resolve.
      if (isIP(literal) !== 0 && !reachable(network, literal)) throw new Unreachable(literal);
      const response = await undiciFetch(url, {
        method,
        headers: [...first.headers],
        ...(body === undefined ? {} : { body }),
        signal: first.signal,
        redirect: 'manual',
        dispatcher,
      });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null) {
        return response as unknown as Response;
      }
      if (hop === REDIRECTS) {
        throw new Error(`${url} redirected more than ${String(REDIRECTS)} times`);
      }
      // As fetch follows a redirect: a 303, or a POST sent on by a 301 or 302, is a GET.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
      }
      url = new URL(location, url).href;
    }
  };
  return guarded as typeof fetch;
}
