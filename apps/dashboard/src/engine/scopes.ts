// What a key may reach and do, as packages/core/src/keys.ts has it: a key of each scope holds only
// the permissions that make sense there, and a key is made with none its maker does not hold.

import { HOLDABLE } from '@acentric/protocol';
import type { Permission, Scope, ScopeType } from '@acentric/protocol';

import type { Me } from '../me.ts';

export type { ScopeType };

/** What each permission lets a key do, in the dialog's words. */
export const PERMISSION_TEXT: { readonly [P in Permission]: string } = {
  'agents:read': 'List agents and their versions',
  'agents:deploy': 'Deploy agents, and delete them',
  'secrets:write': "Set, list and remove agents' secrets",
  'actors:read': 'Read actors: their conversations, inputs and tasks',
  'actors:write': 'Create, change and archive actors',
  'actors:send': 'Send actors inputs',
  'actors:stop': 'Interrupt actors, and retry failed turns',
  'machines:manage': 'Add, change and remove machines and sandboxes',
  'machines:run': 'Run commands on machines, and read and write their files',
  'accounts:manage': 'Add, change and remove model accounts',
  'keys:manage': 'Make, list and revoke keys no wider than itself',
  'users:manage': 'Add and remove people, and change their roles',
  'audit:read': 'Read the audit log',
  'usage:read': 'Read what model calls used and cost',
};

/** The scopes a person may make keys for: a person reaches the whole engine. */
export const SCOPES: readonly ScopeType[] = ['engine', 'agent', 'actor'];

/** The permissions a new key of this scope may be given by `me`: holdable there, and held by them. */
export function grantable(me: Me | undefined, scope: ScopeType): readonly Permission[] {
  return HOLDABLE[scope].filter((permission) => me?.permissions.includes(permission) === true);
}

/** What a key reaches, in a table cell: an agent and an actor by name, where it is known. */
export function reachText(scope: Scope, names: ReadonlyMap<string, string>): string {
  if (scope.type === 'engine') return 'Engine';
  if (scope.type === 'agent') return `Agent ${names.get(scope.agent) ?? scope.agent}`;
  return `Actor ${names.get(scope.actor) ?? scope.actor}`;
}
