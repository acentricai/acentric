// The API keys section of Settings, for one who may manage keys: the keys they may see, each
// revoked from its row, and New key. It uses the API keys page's dialogs.

import { IconPlus, IconX } from '@tabler/icons-react';
import { PERMISSIONS } from '@acentric/protocol';
import type { CreateKeyResponse, Key } from '@acentric/protocol';
import { useState } from 'react';

import {
  KeyShown,
  maskOf,
  NewKeyDialog,
  RevokeKeyDialog,
  useKeys,
  useReachNames,
} from '../engine/keys.tsx';
import { reachText } from '../engine/scopes.ts';
import { date, fullTime } from '../format.ts';
import { useMe } from '../me.ts';
import { Button, LoadError, Skeleton } from '../ui.tsx';

/** How many letters of a name are shown. */
const NAME_LETTERS = 12;

/**
 * A long name as its first words that fit in so many letters, then `…`: the first word cut
 * where one is longer than that alone.
 */
export function shortOf(name: string, most = NAME_LETTERS): string {
  if (name.length <= most) return name;
  let kept = '';
  for (const word of name.split(/\s+/)) {
    const next = kept === '' ? word : `${kept} ${word}`;
    if (next.length > most) break;
    kept = next;
  }
  return `${kept === '' ? name.slice(0, most) : kept}…`;
}

export function KeysSettings() {
  const me = useMe();
  const keys = useKeys();
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<CreateKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const rows = keys.data?.items;
  const names = useReachNames(rows);

  return (
    <div className="prefs-page">
      <section className="prefs-group" aria-labelledby="prefs-keys">
        <div className="prefs-group__head prefs-group__head--spaced">
          <h3 className="prefs-group__title" id="prefs-keys">
            API keys
          </h3>
          <Button size="sm" onClick={() => setCreating(true)}>
            <IconPlus size={15} stroke={1.75} aria-hidden="true" />
            New key
          </Button>
        </div>
        {keys.isPending ? (
          <Skeleton rows={3} label="Loading the keys" />
        ) : keys.isError ? (
          <LoadError things="the keys" error={keys.error} onRetry={() => void keys.refetch()} />
        ) : (
          <table className="prefs-table" aria-label="Keys">
            <thead>
              <tr>
                <th scope="col" aria-label="Key" />
                <th scope="col">Reaches</th>
                <th scope="col">Permissions</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((key) => (
                <tr key={key.id}>
                  <td>
                    <span className="prefs-member__text">
                      <span className="prefs-member__name" title={key.label}>
                        {shortOf(key.label)}
                      </span>
                      <code className="prefs-member__email">{maskOf(key)}</code>
                    </span>
                  </td>
                  <td>{reachText(key.scope, names)}</td>
                  <td title={key.permissions.join(', ')}>
                    {key.permissions.length === PERMISSIONS.length
                      ? 'All'
                      : `${String(key.permissions.length)} of ${String(PERMISSIONS.length)}`}
                  </td>
                  <td title={key.expiresAt === null ? undefined : fullTime(key.expiresAt)}>
                    {key.expiresAt === null ? 'Never' : date(key.expiresAt)}
                  </td>
                  <td title={key.lastUsedAt === null ? undefined : fullTime(key.lastUsedAt)}>
                    {key.lastUsedAt === null ? '—' : date(key.lastUsedAt)}
                  </td>
                  <td className="prefs-table__action">
                    <button
                      type="button"
                      className="prefs-table__out"
                      aria-label={`Revoke ${key.label}`}
                      title="Revoke"
                      onClick={() => setRevoking(key)}
                    >
                      <IconX size={16} stroke={1.75} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {creating && (
        <NewKeyDialog
          me={me.data}
          onClose={() => setCreating(false)}
          onMade={(result) => {
            setCreating(false);
            setMade(result);
          }}
        />
      )}
      {made !== null && <KeyShown made={made} onDone={() => setMade(null)} />}
      {revoking !== null && <RevokeKeyDialog target={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}
