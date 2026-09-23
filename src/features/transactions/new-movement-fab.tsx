"use client";

import { useEffect, useState } from "react";
import MovementForm, { type MovementAction } from "@/features/transactions/movement-form";
import type { InlineCategoryState } from "@/features/transactions/actions";
import type { MovementFormOptions } from "@/features/transactions/form-options";
import { PlusIcon } from "@/components/icons";
import { Sheet } from "@/components/sheet";

/**
 * Shared quick-access tile look (dashboard "Accesos rápidos"): exported so
 * the plain links rendered next to the tile match it exactly.
 */
export const QUICK_TILE_CLASS =
  "flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border border-line bg-surface px-2 text-center text-xs font-medium text-ink transition-colors hover:bg-base";

interface Props extends MovementFormOptions {
  currentUser: { id: string; name: string; role: "admin" | "member" };
  serverToday: string;
  /** Optional data-tour anchor id for the guided tour (on the trigger). */
  tourId?: string;
  /** On md+, keep the trigger visible as an inline header button (the FAB itself is mobile-only). */
  desktopButton?: boolean;
  /**
   * "fab" (default): the fixed FAB alone (plus the md+ inline button with
   * desktopButton). "tile": an in-flow quick-access tile (visible at every
   * breakpoint) NEXT TO the mobile-only FAB — still one sheet, one form,
   * one keyboard listener.
   */
  variant?: "fab" | "tile";
  createAction: MovementAction;
  createCategoryAction: (
    state: InlineCategoryState,
    formData: FormData,
  ) => Promise<InlineCategoryState>;
}

/**
 * Single trigger for creating a movement: below md it is a fixed 56px honey
 * FAB above the bottom nav; on md+ (with desktopButton) the same element
 * renders as the inline header button. Opens the shared bottom sheet with
 * MovementForm. The N keyboard shortcut opens the same sheet (ignored while
 * typing in a field).
 */
export default function NewMovementFab({
  currentUser,
  categories,
  members,
  groups,
  serverToday,
  tourId,
  desktopButton = false,
  variant = "fab",
  createAction,
  createCategoryAction,
}: Props) {
  const [open, setOpen] = useState(false);

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
      {/* Quick-access tile (variant="tile"): in-flow, all breakpoints. */}
      {variant === "tile" && (
        <button type="button" onClick={() => setOpen(true)} className={QUICK_TILE_CLASS}>
          <PlusIcon className="size-5" />
          <span>Nuevo movimiento</span>
        </button>
      )}

      {/* One DOM node with one data-tour anchor: driver.js highlights the
          first match, so the FAB and the header button must be the SAME
          element, restyled per breakpoint. */}
      <button
        type="button"
        data-tour={tourId}
        onClick={() => setOpen(true)}
        aria-label="Nuevo movimiento"
        className={
          desktopButton
            ? "fixed right-4 bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))] z-40 inline-flex size-14 items-center justify-center rounded-full bg-honey text-on-accent shadow-lg transition-colors hover:brightness-95 md:static md:size-auto md:gap-2 md:rounded-lg md:bg-ink md:text-base md:px-4 md:py-2 md:text-sm md:font-medium md:shadow-none md:hover:bg-ink/90"
            : "fixed right-4 bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))] z-40 inline-flex size-14 items-center justify-center rounded-full bg-honey text-on-accent shadow-lg transition-colors hover:brightness-95 md:hidden"
        }
      >
        <PlusIcon className="size-6 shrink-0" />
        <span className={desktopButton ? "hidden md:inline" : "sr-only"}>Nuevo movimiento</span>
        <kbd
          className={
            desktopButton
              ? "hidden rounded border border-base/40 px-1.5 text-xs font-normal md:inline-block"
              : "hidden"
          }
        >
          N
        </kbd>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Nuevo movimiento">
        <MovementForm
          mode="create"
          categories={categories}
          members={members}
          groups={groups}
          currentUser={currentUser}
          serverToday={serverToday}
          createAction={createAction}
          updateAction={createAction}
          createCategoryAction={createCategoryAction}
          submitSticky
          onSuccess={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
