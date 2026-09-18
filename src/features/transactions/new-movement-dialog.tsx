"use client";

import { useEffect, useRef, useState } from "react";
import MovementForm, { type MovementAction } from "@/features/transactions/movement-form";
import type { InlineCategoryState } from "@/features/transactions/actions";
import type { MovementFormOptions } from "@/features/transactions/form-options";

interface Props extends MovementFormOptions {
  currentUser: { id: string; name: string; role: "admin" | "member" };
  serverToday: string;
  /** Optional data-tour anchor id for the guided tour (on the open button). */
  tourId?: string;
  createAction: MovementAction;
  createCategoryAction: (
    state: InlineCategoryState,
    formData: FormData,
  ) => Promise<InlineCategoryState>;
}

/**
 * "Nuevo movimiento" entry point: native <dialog> opened by button or the N
 * keyboard shortcut (ignored while typing in inputs). The form unmounts on
 * close, so every opening starts fresh.
 */
export default function NewMovementDialog({
  currentUser,
  categories,
  envelopes,
  members,
  groups,
  serverToday,
  tourId,
  createAction,
  createCategoryAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  // Keyboard shortcut N (no modifiers, not while typing in a field).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        data-tour={tourId}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90"
      >
        Nuevo movimiento
        <kbd className="rounded border border-base/40 px-1.5 text-xs font-normal">
          N
        </kbd>
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        className="m-auto max-h-[85vh] w-[44rem] max-w-[92vw] overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl backdrop:bg-black/40"
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-ink">
                Nuevo movimiento
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-base"
              >
                ✕
              </button>
            </div>
            <MovementForm
              mode="create"
              categories={categories}
              envelopes={envelopes}
              members={members}
              groups={groups}
              currentUser={currentUser}
              serverToday={serverToday}
              createAction={createAction}
              updateAction={createAction}
              createCategoryAction={createCategoryAction}
            />
          </div>
        )}
      </dialog>
    </>
  );
}
