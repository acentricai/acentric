// A popover's open state: closes on an outside press or Escape, and hands
// focus back to the button that opened it. A popover rendered elsewhere in
// the document (a portal, to escape a scrolling table) sets `popup`, so a
// press inside it doesn't count as outside.
import { useEffect, useRef, useState } from 'react';

export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<T>(null);
  const popup = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!container.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return { open, setOpen, container, trigger, popup, close };
}
