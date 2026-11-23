// Signing out: ends this browser's session at the server, forgets what was read, and tells the
// other tabs.

import { api, queryClient } from './api.ts';
import { tellOtherTabs } from './session.ts';

export async function signOut(): Promise<void> {
  // Signed out here whatever the server says: the cookie it clears is its own to clear.
  await api.call('auth.signOut').catch(() => undefined);
  queryClient.clear();
  tellOtherTabs();
}
