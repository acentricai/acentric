// What the browser keeps of the dashboard: the theme. The session itself is the server's cookie,
// which the page cannot read. Signing in or out in one tab is told to the others, which then
// ask the server again who is signed in.

const THEME = 'acentric.theme';

export type Theme = 'system' | 'light' | 'dark';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function theme(): Theme {
  const chosen = read(THEME);
  return chosen === 'light' || chosen === 'dark' ? chosen : 'system';
}

/** Sets the theme on the document: `data-theme` for a choice, nothing to follow the system. */
export function applyTheme(chosen: Theme): void {
  if (chosen === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = chosen;
}

const CHANNEL = 'acentric.session';

/** Tells the other tabs that who is signed in changed. */
export function tellOtherTabs(): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // A browser with no channels: the other tabs find out at their next call.
  }
}

/** Calls back when another tab signed in or out; returns the way to stop. */
export function onOtherTab(changed: () => void): () => void {
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return () => {};
  }
  channel.addEventListener('message', changed);
  return () => channel.close();
}
