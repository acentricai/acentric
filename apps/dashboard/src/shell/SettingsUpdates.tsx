// The Updates section of Settings, for one who runs the server: its version, whether there is a
// newer one, and what changed in each version after it, as GitHub's releases say. Where an
// updater runs beside the server, the next version is downloaded and taken from here, now or at
// a time; elsewhere it is taken where the server runs.

import { IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import type { UpdateRequest, Updates, UpdaterState } from '@acentric/protocol';

import { engine, queryClient } from '../engine/api.ts';
import { date, longTime } from '../format.ts';
import { Markdown } from '../markdown.tsx';
import { may, useMe } from '../me.ts';
import { startUpdating } from '../updating.tsx';
import { Button, Dialog, Field, FormError, LoadError, Notice, Skeleton } from '../ui.tsx';

/** What the updater is doing while it is asked again every few seconds. */
const BUSY: readonly UpdaterState[] = ['downloading', 'waiting', 'updating'];

export const updateQueries = { status: ['updates'] as const };

export function UpdatesSettings() {
  const me = useMe();
  // Once asked, until the updater says something new: what it said then, and when it was asked,
  // so that it is not waited for long when it says nothing.
  const [answer, setAnswer] = useState<{
    readonly was: string;
    readonly since: number;
    /** What it was asked, as the row says it meanwhile. */
    readonly doing: string;
  } | null>(null);
  // It was asked, and said nothing for a minute.
  const [unanswered, setUnanswered] = useState(false);
  const status = useQuery({
    queryKey: updateQueries.status,
    queryFn: ({ signal }) => engine.updates(false, signal),
    // While the updater works, what it does is read again: and while the server restarts.
    refetchInterval: (query) => {
      if (answer !== null) return 2000;
      const state = query.state.data?.updater?.state;
      return state !== undefined && BUSY.includes(state) ? 3000 : false;
    },
  });
  // All the updater says, as one: that it said something else is that it answered.
  const now = status.data?.updater;
  const heard =
    now == null ? '' : [now.state, now.version, now.at, now.changedAt, now.error].join('|');
  if (answer !== null && heard !== answer.was) setAnswer(null);
  else if (answer !== null && Date.now() - answer.since > 60_000) {
    setAnswer(null);
    setUnanswered(true);
  }
  // What the updater said before it was asked: it has answered once it says something else.
  const asking = (doing: string) => {
    setUnanswered(false);
    setAnswer({ was: heard, since: Date.now(), doing });
  };
  const asked = (said: Updates) => queryClient.setQueryData(updateQueries.status, said);
  const check = useMutation({
    mutationFn: () => engine.updates(true),
    onSuccess: (said) => queryClient.setQueryData(updateQueries.status, said),
  });
  const data = status.data;
  const [dialog, setDialog] = useState<'now' | 'later' | null>(null);
  const ask = useMutation({
    mutationFn: (body: UpdateRequest) => engine.requestUpdate(body),
    onMutate: (body) =>
      asking(
        body.action === 'download'
          ? `Downloading ${body.version}…`
          : body.at == null
            ? `Updating to ${body.version}…`
            : 'Scheduling…',
      ),
    onError: () => setAnswer(null),
    onSuccess: (said) => {
      asked(said);
      setDialog(null);
    },
  });
  const cancel = useMutation({
    mutationFn: () => engine.cancelUpdate(),
    onMutate: () => asking('Cancelling…'),
    onError: () => setAnswer(null),
    onSuccess: asked,
  });
  const updater = data?.updater ?? null;
  // Taking a version, the server restarts: every page says it is updating meanwhile.
  useEffect(() => {
    if (updater?.state === 'updating') startUpdating();
  }, [updater?.state]);
  const manages = me.data !== undefined && may(me.data, 'updates:manage');

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-updates">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-updates">
            Updates
          </h3>
          {data !== undefined && data.check !== 'off' && (
            <Button size="sm" busy={check.isPending} onClick={() => check.mutate()}>
              <IconRefresh size={15} stroke={1.75} aria-hidden="true" />
              Check now
            </Button>
          )}
        </div>
        <FormError error={check.error ?? cancel.error} />
        {status.isPending ? (
          <Skeleton rows={3} label="Loading the updates" />
        ) : data === undefined ? (
          <LoadError
            things="the updates"
            error={status.error}
            onRetry={() => void status.refetch()}
          />
        ) : (
          <>
            {(data.check !== 'ok' || updater?.state === 'failed' || unanswered) && (
              <div className="prefs-notices">
                {unanswered && <Notice tone="warn" title="The updater did not answer" />}
                {updater?.state === 'failed' && (
                  <Notice tone="danger" title={`The update to ${updater.version ?? 'it'} failed`}>
                    {updater.error}
                  </Notice>
                )}
                {data.check === 'failed' && (
                  <Notice tone="danger" title="Updates could not be checked">
                    {data.error}
                  </Notice>
                )}
                {data.check === 'off' && <Notice title="Update checks are off" />}
              </div>
            )}
            <div className="prefs-rows">
              <div className="prefs-row">
                <span className="prefs-row__name">Current version</span>
                <span className="prefs-row__form">
                  {data.latest !== null ? (
                    <span className="tag tag--update">Update available</span>
                  ) : (
                    data.check === 'ok' && <span className="tag">Up to date</span>
                  )}
                  <span className="prefs-row__plain">{data.current}</span>
                </span>
              </div>
              {data.check !== 'off' && (
                <div className="prefs-row">
                  <span className="prefs-row__name">Latest version</span>
                  <span className="prefs-row__plain">{data.latest ?? data.current}</span>
                </div>
              )}
              {updater !== null && manages && (
                <UpdateRow
                  data={data}
                  answering={answer?.doing ?? null}
                  busy={cancel.isPending}
                  onAsk={(body) => ask.mutate(body)}
                  onLater={() => setDialog('later')}
                  onNow={() => setDialog('now')}
                  onCancel={() => cancel.mutate()}
                />
              )}
            </div>
            {data.releases.length > 0 && (
              <div className="prefs-releases" aria-label="Releases">
                {data.releases.map((release) => (
                  <article key={release.version} className="prefs-release">
                    <header className="prefs-release__head">
                      <span className="prefs-release__version">{release.version}</span>
                      <span className="prefs-release__date">{date(release.publishedAt)}</span>
                      {release.url !== '' && (
                        <a
                          className="prefs-release__link"
                          href={release.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${release.version} on GitHub`}
                          title="On GitHub"
                        >
                          <IconExternalLink size={15} stroke={1.75} aria-hidden="true" />
                        </a>
                      )}
                    </header>
                    <Markdown text={release.notes} className="md" />
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {dialog === 'now' && data?.next != null && (
        <UpdateNowDialog
          version={data.next}
          busy={ask.isPending}
          error={ask.error}
          onUpdate={() => ask.mutate({ version: data.next as string, action: 'install' })}
          onClose={() => {
            ask.reset();
            setDialog(null);
          }}
        />
      )}
      {dialog === 'later' && data?.next != null && (
        <ScheduleDialog
          version={data.next}
          busy={ask.isPending}
          error={ask.error}
          onSchedule={(at) => ask.mutate({ version: data.next as string, action: 'install', at })}
          onClose={() => {
            ask.reset();
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

/** What the updater is doing about the next version, and what may be asked of it. */
function UpdateRow({
  data,
  answering,
  busy,
  onAsk,
  onNow,
  onLater,
  onCancel,
}: {
  data: Updates;
  /** What it was asked, while the updater has not answered: null once it has. */
  answering: string | null;
  busy: boolean;
  onAsk: (body: UpdateRequest) => void;
  onNow: () => void;
  onLater: () => void;
  onCancel: () => void;
}) {
  const updater = data.updater;
  if (updater === null) return null;
  const next = data.next;
  const of = updater.version;
  // What it did about another version than the next is past: the next is asked for afresh.
  const about = of !== null && of === next;
  if (answering !== null) {
    return (
      <div className="prefs-row">
        <span className="prefs-row__name">Update</span>
        <span className="prefs-row__plain">{answering}</span>
      </div>
    );
  }
  // What it does now, and what may be asked of it then. A version it is busy with is said, and
  // what it did is past once there is a newer one to take: that one is offered afresh.
  let said: string | null = null;
  let actions: 'download' | 'downloaded' | 'waiting' | null = null;
  if (updater.state === 'downloading') said = `Downloading ${of ?? ''}…`;
  else if (updater.state === 'updating') said = `Updating to ${of ?? ''}…`;
  else if (updater.state === 'waiting') {
    said = `${of ?? ''} at ${updater.at === null ? '—' : longTime(updater.at)}`;
    actions = 'waiting';
  } else if (updater.state === 'downloaded' && about) {
    said = `${of} downloaded`;
    actions = 'downloaded';
  } else if (next !== null) {
    said = next;
    actions = 'download';
  } else if (updater.state === 'done' && of === data.current) {
    said = `Updated to ${of}`;
  }
  if (said === null) return null;
  return (
    <div className="prefs-row">
      <span className="prefs-row__name">Update</span>
      <span className="prefs-row__form">
        <span className="prefs-row__plain">{said}</span>
        {actions === 'download' && next !== null && (
          <Button size="sm" onClick={() => onAsk({ version: next, action: 'download' })}>
            Download
          </Button>
        )}
        {actions === 'downloaded' && (
          <>
            <Button size="sm" onClick={onLater}>
              Schedule
            </Button>
            <Button size="sm" variant="primary" onClick={onNow}>
              Update now
            </Button>
          </>
        )}
        {actions === 'waiting' && (
          <>
            <Button size="sm" busy={busy} onClick={onCancel}>
              Cancel
            </Button>
            {/* Set for later, it may be taken now instead: while it is still the next. */}
            {about && (
              <Button size="sm" variant="primary" onClick={onNow}>
                Update now
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/** Asks whether to take the version now: the server restarts. */
function UpdateNowDialog({
  version,
  busy,
  error,
  onUpdate,
  onClose,
}: {
  version: string;
  busy: boolean;
  error: unknown;
  onUpdate: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={`Update to ${version} now?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} onClick={onUpdate}>
            Update now
          </Button>
        </>
      }
    >
      <FormError error={error} />
    </Dialog>
  );
}

/** `2026-11-25T03:00`, as a datetime-local input takes it: the next 03:00 here. */
function tonight(now = new Date()): string {
  const at = new Date(now);
  at.setHours(3, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** When to take the version. */
function ScheduleDialog({
  version,
  busy,
  error,
  onSchedule,
  onClose,
}: {
  version: string;
  busy: boolean;
  error: unknown;
  onSchedule: (at: number) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const [when, setWhen] = useState(tonight);
  const at = new Date(when).getTime();
  const ready = Number.isFinite(at) && at > Date.now();
  return (
    <Dialog
      title={`Schedule the update to ${version}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="primary" busy={busy} disabled={!ready}>
            Schedule
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !busy) onSchedule(at);
        }}
      >
        <Field label="When">
          {(id) => (
            <input
              id={id}
              className="ac-input"
              type="datetime-local"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          )}
        </Field>
        <FormError error={error} />
      </form>
    </Dialog>
  );
}
