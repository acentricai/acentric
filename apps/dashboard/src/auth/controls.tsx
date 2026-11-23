import { IconAlertCircle, IconX } from '@tabler/icons-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { Spinner } from './icons.tsx';

export function AuthButton({
  children,
  busy = false,
  secondary = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly busy?: boolean;
  readonly secondary?: boolean;
}) {
  return (
    <button
      {...props}
      className={`ac-btn ${secondary ? 'ac-btn--secondary' : 'ac-btn--primary'} auth__control ${className}`}
      aria-busy={busy || undefined}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** A field of a form of signing in: its label, its input, and what it asks for. */
export function AuthField({
  id,
  label,
  optional = false,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
  readonly hint?: string;
}) {
  return (
    <div className="ac-field">
      <label className="ac-field__label" htmlFor={id}>
        {label}
        {optional && <span className="ac-field__optional"> (optional)</span>}
      </label>
      <input
        id={id}
        className="ac-input auth__control"
        {...(hint === undefined ? {} : { 'aria-describedby': `${id}-hint` })}
        {...input}
      />
      {hint !== undefined && (
        <p className="ac-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A request's error, as a toast at the foot of the form's column. With `onDismiss` it has a
 * close button; without, it is a standing condition that stays while it holds.
 */
export function AuthToast({
  children,
  id,
  onDismiss,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly onDismiss?: (() => void) | undefined;
}) {
  return (
    <div className="ac-toaster" role="region" aria-label="Notifications">
      <div className="ac-toast ac-toast--danger" id={id} role="alert">
        <IconAlertCircle className="ac-toast__icon" size={18} stroke={1.75} aria-hidden="true" />
        <p className="ac-toast__title">{children}</p>
        {onDismiss !== undefined && (
          <button
            type="button"
            className="ac-toast__close"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <IconX size={16} stroke={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
