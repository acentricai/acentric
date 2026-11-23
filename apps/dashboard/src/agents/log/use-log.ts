// Reading an actor's conversation for the page: all of it from the first message, then each
// message as it joins, with where the actor stands each time that changes, over one stream.
//
// The state belongs to one actor: the page mounts this afresh for another (keyed by the actor),
// and the stream carries the abort signal of its mount, so nothing about one actor lands in
// another's log.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { engine } from '../api.ts';
import { useCompactions } from '../queries.ts';
import { buildLog, startsOpen, type Band, type LogItem, type Message } from './model.ts';
import { followConversation, type Standing, type StreamState } from './stream.ts';

export type ActorLog = {
  readonly items: readonly LogItem[];
  /** Whether the stream has given out what there was when the page opened. */
  readonly ready: boolean;
  readonly stream: StreamState | 'idle';
  readonly error: unknown;
  /** The turns whose bands are open. */
  readonly open: ReadonlySet<number>;
  toggle(turn: number): void;
  /** Opens the band that holds `seq`. */
  reveal(seq: number): void;
  readonly standing: Standing | undefined;
};

export function useActorLog(
  actor: string,
  options: {
    readonly onMessages?: (messages: Message[]) => void;
    readonly onStanding?: (standing: Standing) => void;
  } = {},
): ActorLog {
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [standing, setStanding] = useState<Standing | undefined>(undefined);
  const [stream, setStream] = useState<StreamState | 'idle'>('idle');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<number, boolean>>(new Map());
  const compactions = useCompactions(actor);
  const callbacks = useRef(options);
  callbacks.current = options;

  useEffect(() => {
    const abort = new AbortController();
    void followConversation({
      open: (after, signal) => engine.events(actor, after, signal),
      after: 0,
      signal: abort.signal,
      onMessages: (fresh) => {
        setMessages((was) => [...was, ...fresh]);
        callbacks.current.onMessages?.(fresh);
      },
      onStanding: (next) => {
        setStanding(next);
        // The engine says where the actor stands after the messages it had: those are all in.
        setReady(true);
        setError(null);
        callbacks.current.onStanding?.(next);
      },
      onState: (state) => {
        setStream(state);
        if (state === 'ended') setReady(true);
      },
    }).catch((failure: unknown) => setError(failure));
    return () => abort.abort();
  }, [actor]);

  // A compaction is not a message: it is read again when the actor's standing changes.
  const refetch = compactions.refetch;
  useEffect(() => {
    if (standing !== undefined) void refetch();
  }, [standing, refetch]);

  const items = useMemo(
    () => buildLog(messages, compactions.data?.items ?? [], standing),
    [messages, compactions.data, standing],
  );

  const bands = items.filter((item): item is Band => item.type === 'band');
  const lastTurn = bands.at(-1)?.turn;
  const open = useMemo(() => {
    const out = new Set<number>();
    for (const band of bands) {
      const chosen = toggled.get(band.turn);
      if (chosen ?? startsOpen(band, lastTurn)) out.add(band.turn);
    }
    return out;
  }, [bands, toggled, lastTurn]);

  const toggle = useCallback(
    (turn: number) =>
      setToggled((was) => {
        const next = new Map(was);
        next.set(turn, !open.has(turn));
        return next;
      }),
    [open],
  );

  const reveal = useCallback(
    (seq: number) => {
      const band = bands.find((each) => seq >= each.first && seq <= each.last);
      if (band === undefined) return;
      setToggled((was) => new Map(was).set(band.turn, true));
    },
    [bands],
  );

  return {
    items,
    ready,
    stream,
    error: error ?? compactions.error,
    open,
    toggle,
    reveal,
    standing,
  };
}
