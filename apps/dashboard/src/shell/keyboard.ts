// Whether a key press belongs to what has focus, for the app's own keys
// (`/` go to, the actor page's keys). ⌘B and Ctrl+B are the shell's.

/** Whether a key press is typing, or would land in a dialog. */
export function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (document.body.dataset['dialog'] === 'open') return true;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  if (target === null) return false;
  return (
    target.isContentEditable || target.closest('input, textarea, select, [role="menu"]') !== null
  );
}
