// The person signed in, as the server says: what they may do decides which pages they see.

import type { Permission, Principal } from '@acentric/protocol';
import { useQuery } from '@tanstack/react-query';

import { meQuery } from './api.ts';

/** A person signed in. Only a person signs in to the dashboard: a key is for programs. */
export type Me = Extract<Principal, { readonly type: 'user' }>;

export function useMe() {
  const query = useQuery(meQuery);
  return { ...query, data: query.data?.type === 'user' ? query.data : undefined };
}

/** Whether the person may do what a permission lets. */
export const may = (me: Me, permission: Permission): boolean => me.permissions.includes(permission);
