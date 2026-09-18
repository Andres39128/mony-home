"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from "react";

interface SheetProps {
  /** Controlled open state. */
  open: boolean;
  /** Called on every close path: ✕ button, backdrop click, Esc, navigation. */
  onClose: () => void;
  /** Visible heading and accessible name of the sheet. */
  title: string;
  children: ReactNode;
}

/** How long the slide-out animation runs before the native close(). */
const CLOSE_MS = 200;

/**
 * Reusable bottom sheet built on the native <dialog> element (focus trap,
 * Esc to close, ::backdrop and focus return come for free).
 *
 * Mobile: anchored to the bottom edge with a grabber handle. md+: the same
 * element renders as a centered dialog. One component, responsive classes.
 *
 * The slide-up motion (200ms ease-out) runs on open and close; with
 * prefers-reduced-motion: reduce both become instant. Content unmounts on
 * close, so embedded forms start fresh on every open.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Panel transform/opacity: false = below the viewport (closing position).
  const [entered, setEntered] = useState(false);
  // Content mount flag: keeps children alive during the close animation.
  const [mounted, setMounted] = useState(false);
  // Guards close() being called on a dialog that was never opened.
  const shownRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !shownRef.current) {
      shownRef.current = true;
      setMounted(true);
      setEntered(false);
      dialog.showModal();
      // Two frames so the below-screen position paints before the transition.
      const raf = requestAnimationFrame(() =>
        requestAnimationFrame(() => setEntered(true)),
      );
      return () => cancelAnimationFrame(raf);
    }

    if (!open && shownRef.current) {
      shownRef.current = false;
      setEntered(false); // animate back down
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const timer = setTimeout(() => dialog.close(), reduced ? 0 : CLOSE_MS);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Esc fires `cancel` first: take over so the close animates like the button.
  function handleCancel(event: SyntheticEvent<HTMLDialogElement>) {
    event.preventDefault();
    onClose();
  }

  // Native close (ours via timeout): reset content and sync parent state.
  function handleClose() {
    setMounted(false);
    onClose();
  }

  // The ::backdrop is not a DOM node; clicks on the dialog itself that did
  // not land on the panel content are backdrop clicks.
  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onCancel={handleCancel}
      onClick={handleBackdropClick}
      aria-label={title}
      className={`fixed inset-0 m-auto mb-0 mt-auto flex h-fit max-h-[85dvh] w-full max-w-full flex-col overflow-hidden rounded-t-3xl bg-surface shadow-2xl backdrop:bg-black/40 md:m-auto md:w-[26rem] md:max-w-[92vw] md:rounded-3xl ${
        entered ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"
      } transition-all duration-200 ease-out motion-reduce:transition-none`}
    >
      {/* Grabber handle (mobile only). */}
      <div
        aria-hidden
        className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-line md:hidden"
      />
      <div className="flex shrink-0 items-center justify-between gap-2 px-5 pb-1 pt-2">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <button
          type="button"
          onClick={() => onClose()}
          aria-label="Cerrar"
          className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {mounted && children}
      </div>
    </dialog>
  );
}
