// While the server takes a new version, the dashboard says it is updating, in place of every
// page, and opens again at its home once the server answers: the dashboard is the new version's
// then, which a full load of the page takes. It is updating when the server says so at /health
// (while a new version upgrades the database, which serves the dashboard meanwhile), or when
// the Updates section sees the updater take a version (while the server restarts). A version
// taken where the server runs is seen too: /health then says another version than it did.

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { AuthFrame, Intro, Step } from './auth/AuthLayout.tsx';
import { engine } from './engine/api.ts';

/** How often /health is read: while updating, and else. */
const UPDATING_MS = 2000;
const IDLE_MS = 20_000;

let updating = false;
const listeners = new Set<() => void>();

/** The dashboard says it is updating, until the server answers again. */
export function startUpdating(): void {
  if (updating) return;
  updating = true;
  for (const listener of listeners) listener();
}

/** As when the page opened: for a test that opens the dashboard again in the same page. */
export function resetUpdating(): void {
  updating = false;
  reopened = false;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What /health says: a version, and whether it is upgrading. Undefined when it says nothing. */
async function health(): Promise<{ readonly version: string; readonly up: boolean } | undefined> {
  try {
    const answer = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const said = (await answer.json()) as { version?: unknown; upgrading?: unknown };
    if (typeof said.version !== 'string') return undefined;
    if (said.upgrading === true) return { version: said.version, up: false };
    return { version: said.version, up: answer.ok };
  } catch {
    // Not reached: as while it restarts.
    return undefined;
  }
}

/** What the updater is doing, as the server says: undefined when it cannot say now. */
async function updaterState(): Promise<string | undefined> {
  try {
    return (await engine.updates(false)).updater?.state ?? 'idle';
  } catch {
    return undefined;
  }
}

/** Opens the dashboard again at its home, as the version that answers now has it: a test says what instead. */
export const reopening = { to: (path: string) => window.location.replace(path) };
let reopened = false;
const reopen = () => {
  if (reopened) return;
  reopened = true;
  reopening.to('/');
};

export function UpdatingPage() {
  return (
    <AuthFrame>
      <Step key="updating">
        <Intro title="Updating…" center />
      </Step>
    </AuthFrame>
  );
}

/** The page, or that the server is updating: what /health says first is waited for. */
export function UpdatingGate({ children }: { readonly children: ReactNode }) {
  const isUpdating = useSyncExternalStore(subscribe, () => updating);
  // The version the page opened on: another one answering is another version taken.
  const [opened, setOpened] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first: string | null | undefined;
    // That the server said it upgrades its database: once it answers, the update is done.
    let upgraded = false;
    // One look at a time: one that is under way schedules the next itself.
    let looking = false;
    const look = async () => {
      looking = true;
      const said = await health();
      looking = false;
      if (stop) return;
      if (first === undefined) {
        first = said?.version ?? null;
        setOpened(first);
      }
      if (said !== undefined && !said.up) {
        upgraded = true;
        startUpdating();
      } else if (said?.up === true) {
        // Another version answers, or the one that upgraded does: it is done.
        if (upgraded || (first !== null && said.version !== first)) {
          reopen();
          return;
        }
        // The updater says it is done, or failed and put the version before back.
        if (updating) {
          looking = true;
          const state = await updaterState();
          looking = false;
          if (stop) return;
          if (state !== undefined && state !== 'updating') {
            reopen();
            return;
          }
        }
      }
      timer = setTimeout(() => void look(), updating ? UPDATING_MS : IDLE_MS);
    };
    void look();
    // Updating is seen at once, not at the next look.
    const unsubscribe = subscribe(() => {
      if (looking) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void look(), UPDATING_MS);
    });
    return () => {
      stop = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  if (isUpdating) return <UpdatingPage />;
  // Nothing, for the moment /health takes to answer: rather than a page that then goes.
  if (opened === undefined) return null;
  return children;
}
