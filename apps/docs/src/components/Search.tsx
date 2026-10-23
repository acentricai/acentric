/**
 * The search dialog: ⌘K, Ctrl+K or `/` opens it from anywhere, arrows move
 * through results, Enter opens one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { IconCornerDownLeft, IconFileText, IconHash, IconSearch } from '@tabler/icons-react';
import { excerpt } from '../lib/excerpt';
import type { Hit } from '../lib/search';

// The index and its library load the first time search opens.
const searchModule = () => import('../lib/search');
const searchIndex = () => searchModule().then((module) => module.searchIndex());

export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const typing = target?.closest('input, textarea, [contenteditable="true"]');
      if (
        (event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !typing)
      ) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

export function SearchButton({ onOpen }: { onOpen: () => void }) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button type="button" className="search-button" onClick={onOpen} aria-label="Search the docs">
      <IconSearch size={16} stroke={1.6} aria-hidden />
      <span className="search-button-label">Search</span>
      <kbd className="search-button-key">{mac ? '⌘' : 'Ctrl '}K</kbd>
    </button>
  );
}

type Status = 'loading' | 'ready' | 'failed';

export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>('loading');
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      input.current?.select();
      searchIndex().then(
        () => setStatus('ready'),
        () => setStatus('failed'),
      );
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  useEffect(() => {
    if (status !== 'ready' || !query.trim()) {
      setHits([]);
      return;
    }
    let current = true;
    void searchModule().then(async (module) => {
      const search = await module.searchIndex();
      if (!current) return;
      setHits(module.hitsFor(search, query));
      setActive(0);
    });
    return () => {
      current = false;
    };
  }, [query, status]);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const terms = useMemo(() => query.trim().split(/\s+/).filter(Boolean), [query]);

  const go = (hit: Hit) => {
    onClose();
    const [to, hash] = hit.href.split('#');
    void navigate({ to: to || '/', hash });
  };

  return (
    <dialog
      ref={dialog}
      className="search-dialog"
      aria-label="Search the docs"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="search-panel">
        <label className="search-field">
          <IconSearch size={18} stroke={1.6} aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') setActive((i) => Math.min(i + 1, hits.length - 1));
              else if (event.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0));
              else if (event.key === 'Enter' && hits[active]) go(hits[active]);
              else return;
              event.preventDefault();
            }}
            placeholder="Search the docs"
            aria-label="Search the docs"
            aria-controls="search-results"
            aria-activedescendant={hits[active] ? `search-hit-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </label>

        <div className="search-results">
          {status === 'failed' && (
            <p className="search-empty">
              Search couldn't load. Check your connection and try again.
            </p>
          )}
          {status !== 'failed' && query.trim() && hits.length === 0 && (
            <p className="search-empty">
              {status === 'loading' ? 'Loading…' : `Nothing matches “${query.trim()}”.`}
            </p>
          )}
          {!query.trim() && status !== 'failed' && (
            <p className="search-empty">Search guides, references and examples.</p>
          )}
          {hits.length > 0 && (
            <ul id="search-results" ref={list} role="listbox">
              {hits.map((hit, index) => (
                <li
                  key={hit.id}
                  id={`search-hit-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="search-hit"
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(hit)}
                >
                  {hit.heading ? (
                    <IconHash size={16} stroke={1.5} aria-hidden />
                  ) : (
                    <IconFileText size={16} stroke={1.5} aria-hidden />
                  )}
                  <span className="search-hit-body">
                    <span className="search-hit-title">
                      {hit.heading ?? hit.page}
                      {hit.heading && <span className="search-hit-page"> · {hit.page}</span>}
                    </span>
                    <span className="search-hit-text">{excerpt(hit.text, terms)}</span>
                  </span>
                  <IconCornerDownLeft
                    className="search-hit-enter"
                    size={15}
                    stroke={1.5}
                    aria-hidden
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </dialog>
  );
}
