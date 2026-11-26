// An actor's page: its conversation to the left, and beside it, to the right, tabs of what it is
// and what it cost, and of its tasks.

import type { Actor, Task } from '@acentric/protocol';
import { IconChevronRight } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { JsonCode } from '../../code.tsx';

import { count, duration, fullTime, tokens, version } from '../../format.ts';
import { dollars } from '../../llm/format.ts';
import { useUsage } from '../../llm/queries.ts';
import { displayText } from '../../machines/text.tsx';
import { Ago, Button, FormError, LoadError, NOT_FOUND } from '../../machines/ui.tsx';
import { may, useMe } from '../../me.ts';
import { Status } from '../../ui.tsx';
import { engine, isApiError, queryClient } from '../api.ts';
import {
  Conversation,
  contextOf,
  useConversation,
  type ConversationState,
} from '../conversation/conversation.tsx';
import { keys, useActor, useTask, useTasks } from '../queries.ts';
import { CostTab } from './actor-cost.tsx';
import '../agents.css';

/** A line of the sidebar: what it is, and its value beside it. */
function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="actor-fact">
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const TABS = [
  { id: 'overview', name: 'Overview' },
  { id: 'cost', name: 'Cost' },
  { id: 'tasks', name: 'Tasks' },
] as const;

type SideTab = (typeof TABS)[number]['id'];

export function ActorPage() {
  const { actor: id } = useParams({ strict: false }) as { actor: string };
  // Afresh for each actor: its conversation is read from the first.
  return <ActorView key={id} id={id} />;
}

function ActorView({ id }: { id: string }) {
  const actor = useActor(id);
  // Read once, for its conversation and for how large that is in the sidebar.
  const conversation = useConversation(id);
  const [tab, setTab] = useState<SideTab>('overview');
  // A call to the model asked to be shown, from its answer: each ask anew, even of the same one.
  const [reveal, setReveal] = useState<{ seq: number; at: number } | null>(null);
  const split = useSplit();

  if (isApiError(actor.error, 404)) {
    return <p className="table-empty">{NOT_FOUND}</p>;
  }
  const info = actor.data;
  return (
    <div className="actor-page" ref={split.page} style={split.style}>
      <div className="actor-page__main">
        {info !== undefined && (
          <Conversation
            actor={id}
            conversation={conversation}
            onReveal={(seq) => {
              setTab('cost');
              setReveal({ seq, at: Date.now() });
            }}
          />
        )}
      </div>
      <div
        className="actor-split"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the conversation"
        aria-valuemin={MIN_SPLIT}
        aria-valuemax={MAX_SPLIT}
        aria-valuenow={Math.round(split.share)}
        tabIndex={0}
        data-dragging={split.dragging || undefined}
        onPointerDown={split.onPointerDown}
        onKeyDown={split.onKeyDown}
        onDoubleClick={split.reset}
      />
      <aside className="actor-side" aria-label="About the actor">
        <div className="actor-tabs" role="tablist" aria-label="About the actor">
          {TABS.map((one) => (
            <button
              key={one.id}
              type="button"
              role="tab"
              id={`actor-tab-${one.id}`}
              aria-selected={tab === one.id}
              aria-controls={`actor-panel-${one.id}`}
              className="actor-tabs__tab"
              onClick={() => setTab(one.id)}
            >
              {one.name}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`actor-panel-${tab}`}
          aria-labelledby={`actor-tab-${tab}`}
          className="actor-side__panel"
        >
          {actor.isError ? (
            <LoadError
              things="the actor"
              error={actor.error}
              compact
              onRetry={() => void actor.refetch()}
            />
          ) : info === undefined ? (
            <div className="skeleton" role="status" aria-label="Loading the actor">
              <span className="skeleton__line" />
              <span className="skeleton__line" />
              <span className="skeleton__line" />
            </div>
          ) : tab === 'overview' ? (
            <Overview info={info} conversation={conversation} />
          ) : tab === 'cost' ? (
            <CostTab info={info} conversation={conversation} reveal={reveal} />
          ) : (
            <Tasks info={info} />
          )}
        </div>
      </aside>
    </div>
  );
}

/** How much of the page, in percent, the conversation takes; the sidebar the rest. */
const SPLIT = 65;
const MIN_SPLIT = 35;
const MAX_SPLIT = 80;
const SPLIT_KEY = 'acentric.actor-split';

function savedSplit(): number {
  try {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    return saved >= MIN_SPLIT && saved <= MAX_SPLIT ? saved : SPLIT;
  } catch {
    return SPLIT;
  }
}

/** The line between the conversation and the sidebar: dragged, or moved by the arrow keys. */
function useSplit() {
  const page = useRef<HTMLDivElement>(null);
  const [share, setShare] = useState(savedSplit);
  const [dragging, setDragging] = useState(false);
  const set = (next: number) => {
    const clamped = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, next));
    setShare(clamped);
    try {
      localStorage.setItem(SPLIT_KEY, String(clamped));
    } catch {
      // Kept for this page only.
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const box = page.current?.getBoundingClientRect();
    if (box === undefined || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const move = (moved: globalThis.PointerEvent) =>
      set(((moved.clientX - box.left) / box.width) * 100);
    const up = () => {
      setDragging(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') set(share - step);
    else if (event.key === 'ArrowRight') set(share + step);
    else if (event.key === 'Home') set(MIN_SPLIT);
    else if (event.key === 'End') set(MAX_SPLIT);
    else return;
    event.preventDefault();
  };
  const style = { '--split': `${String(share)}%` } as CSSProperties;
  return { page, share, dragging, style, onPointerDown, onKeyDown, reset: () => set(SPLIT) };
}

/** What it is. */
function Overview({ info, conversation }: { info: Actor; conversation: ConversationState }) {
  const me = useMe();
  // An account by its name, for one who may list them; by its ID, for anyone else.
  const accounts = useQuery({
    queryKey: ['accounts', 'list'],
    queryFn: () => engine.accounts(),
    enabled: me.data !== undefined && may(me.data, 'accounts:manage'),
  });
  const account =
    info.account === null
      ? null
      : (accounts.data?.items.find((one) => one.id === info.account)?.name ?? info.account);
  const context = contextOf(conversation.items);
  // What it and the actors under it came to.
  const spent = useUsage({ root: info.id }).data?.total;
  return (
    <>
      <section className="actor-side__group" aria-labelledby="actor-details">
        <h2 className="actor-side__title actor-side__title--unseen" id="actor-details">
          Details
        </h2>
        <dl className="actor-facts">
          <Fact name="Status">
            <Status word={info.status} />
          </Fact>
          <Fact name="Model">
            <span className="mono">{info.modelId}</span>
          </Fact>
          <Fact name="Reasoning">{info.reasoning}</Fact>
          <Fact name="Account">
            {account === null ? (
              <span className="actor-fact__none">Its provider’s default</span>
            ) : (
              <span className="mono" title={info.account ?? undefined}>
                {account}
              </span>
            )}
          </Fact>
          <Fact name="Version">
            <span className="mono">{version(info.deployment.version)}</span>
            <span className="actor-fact__none">
              {info.pinned ? ' · pinned' : ' · follows the active'}
            </span>
          </Fact>
          <Fact name="Created">{fullTime(info.createdAt)}</Fact>
          <Fact name="Cost">{spent === undefined ? '—' : dollars(spent.cost)}</Fact>
          <Fact name="Tokens">
            {spent === undefined ? '—' : tokens(spent.totalInput, spent.output)}
          </Fact>
          <Fact name="Current Context">
            {context === undefined ? '—' : `${count(context)} tokens`}
          </Fact>
        </dl>
      </section>
    </>
  );
}

/** Its tasks: those under way, then those that ended, the newest first; each opens. */
function Tasks({ info }: { info: Actor }) {
  const tasks = useTasks(info.id);
  if (tasks.isError) {
    return (
      <LoadError things="tasks" error={tasks.error} compact onRetry={() => void tasks.refetch()} />
    );
  }
  if (tasks.data === undefined) {
    return (
      <div className="skeleton" role="status" aria-label="Loading tasks">
        <span className="skeleton__line" />
        <span className="skeleton__line" />
      </div>
    );
  }
  const items = tasks.data.items;
  const active = items.filter((task) => task.status === 'running');
  const ended = items.filter((task) => task.status !== 'running');
  return (
    <>
      <TaskGroup title="Active" none="No tasks running" actor={info.id} tasks={active} />
      <TaskGroup title="Earlier" none="No tasks yet" actor={info.id} tasks={ended} />
    </>
  );
}

function TaskGroup({
  title,
  none,
  actor,
  tasks,
}: {
  title: string;
  none: string;
  actor: string;
  tasks: readonly Task[];
}) {
  return (
    <section className="actor-side__group" aria-label={title}>
      <h2 className="actor-side__title">{title}</h2>
      {tasks.length === 0 ? (
        <p className="actor-fact__none actor-tasks__none">{none}</p>
      ) : (
        <ul className="actor-tasks">
          {tasks.map((task) => (
            <TaskRow key={task.id} actor={actor} task={task} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A task: its kind, how it stands and when, and opened, what it was given and came to. */
function TaskRow({ actor, task }: { actor: string; task: Task }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const detail = useTask(actor, open ? task.id : null);
  const stop = useMutation({
    mutationFn: () => engine.stopTask(actor, task.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks(actor) });
      void queryClient.invalidateQueries({ queryKey: keys.actor(actor) });
    },
  });
  const stops = me.data !== undefined && may(me.data, 'actors:stop');
  return (
    <li className="actor-task" data-open={open || undefined}>
      <div className="actor-task__head">
        <button
          type="button"
          className="actor-task__open"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          <IconChevronRight size={14} stroke={1.75} aria-hidden="true" />
          <span className="mono">{task.kind}</span>
        </button>
        <Status word={task.stoppedBy === undefined ? task.status : `stopped · ${task.stoppedBy}`} />
        <span className="actor-task__when">
          {task.endedAt === undefined ? (
            <Ago at={task.startedAt} />
          ) : (
            duration(task.endedAt - task.startedAt)
          )}
        </span>
        {task.status === 'running' && stops && (
          <Button size="sm" variant="quiet" busy={stop.isPending} onClick={() => stop.mutate()}>
            Stop
          </Button>
        )}
      </div>
      {open && (
        <div className="actor-task__detail">
          {detail.data === undefined ? (
            <span className="skeleton__line" />
          ) : (
            <>
              <JsonCode value={detail.data.input} what="what it was started with" />
              {detail.data.result !== null && (
                <pre className="actor-task__result">{displayText(detail.data.result, true)}</pre>
              )}
            </>
          )}
        </div>
      )}
      <FormError error={stop.error ?? detail.error} />
    </li>
  );
}
