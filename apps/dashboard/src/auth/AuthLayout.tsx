import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import '../styles/auth.css';

/** Whether the artwork has come in since the page loaded: it does so once, not at each step. */
let artShown = false;

/** The frame of every page of signing in: the form on the ground, and the artwork beside it. */
export function AuthFrame({ children }: { readonly children: ReactNode }) {
  const settled = useRef(artShown).current;
  useEffect(() => {
    artShown = true;
  }, []);
  return (
    <div className="ac-root auth">
      <div className="auth__side">
        <header className="auth__header">
          <Link to="/" className="auth__brand" aria-label="Acentric">
            <img className="auth__mark" src="/acentric-mark-cropped.png" alt="" />
          </Link>
        </header>
        <main className="auth__main" id="main">
          {children}
        </main>
        <footer className="auth__footer" />
      </div>
      <div className="auth__art" aria-hidden="true">
        <img
          src="/art/door.webp"
          alt=""
          className={settled ? 'auth__art-img auth__art-img--settled' : 'auth__art-img'}
        />
      </div>
    </div>
  );
}

/** One step of a page. A page keys it, so that each step's entrance plays again. */
export function Step({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={`auth__step ${className}`}>{children}</div>;
}

/** A step's heading, and what it says under it. */
export function Intro({
  title,
  children,
  center = false,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly center?: boolean;
}) {
  const classes = ['auth__intro', 'rise'];
  if (center) classes.push('auth__intro--center');
  if (children === undefined) classes.push('auth__intro--spaced');
  return (
    <div className={classes.join(' ')}>
      <h1 className="auth__title">{title}</h1>
      {children !== undefined && <p className="auth__lede">{children}</p>}
    </div>
  );
}
