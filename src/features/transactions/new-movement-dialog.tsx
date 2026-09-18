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
        className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Nuevo movimiento
        <kbd className="rounded border border-white/30 px-1.5 text-xs font-normal dark:border-zinc-500">
          N
        </kbd>
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        className="m-auto max-h-[85vh] w-[44rem] max-w-[92vw] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900"
      >
        {open && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
                Nuevo movimiento
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
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
