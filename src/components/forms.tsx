"use client";

import type { ReactNode } from "react";
import type { FormState } from "@/lib/form-state";
import { PencilIcon, PlusIcon, TrashIcon } from "@/components/icons";

/**
 * Small form feedback primitives shared by every admin CRUD panel.
 * Extracted after appearing verbatim in three or more panels.
 */

export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink focus:ring-2 focus:ring-ink/10";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-danger-text">{message}</p>;
}

export function FormError({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-fill px-3 py-2 text-sm text-on-accent">
      {state.error}
    </p>
  );
}

export function OkMessage({ state, text = "Cambios guardados." }: { state: FormState; text?: string }) {
  if (!state.ok) return null;
  return (
    <p role="status" className="rounded-lg bg-sage px-3 py-2 text-sm text-on-accent">
      {text}
    </p>
  );
}

export function SubmitButton({
  pending,
  children,
  variant = "primary",
}: {
  pending: boolean;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
}) {
  const variantClass =
    variant === "danger"
      ? "border border-danger-fill text-danger-text hover:bg-danger-soft"
      : variant === "secondary"
        ? "border border-line text-muted hover:bg-base"
        : "bg-ink text-base hover:bg-ink/90";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex min-h-11 items-center self-start rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${variantClass}`}
    >
      {children}
    </button>
  );
}

/** Inactive/active pill shared by list views. */
export function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={
        active
          ? "rounded-full bg-sage px-2 py-0.5 text-xs font-medium text-on-accent"
          : "rounded-full bg-line px-2 py-0.5 text-xs font-medium text-ink"
      }
    >
      {active ? "Activa" : "Inactiva"}
    </span>
  );
}

/**
 * Collapsible card for admin edit forms: native <details>/<summary> (works
 * without JS) with an explicit "Editar" affordance and a chevron that rotates
 * while open, so the edit controls are discoverable.
 */
export function EditDetails({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-6 py-4 font-medium text-ink hover:bg-base [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block shrink-0 text-xs text-muted transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        <span className="rounded-md border border-line px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted">
          Editar
        </span>
        {summary}
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-6 py-4">
        {children}
      </div>
    </details>
  );
}

/** Panel header button that opens the create Sheet (progressive disclosure). */
export function CreateTrigger({
  label,
  tourId,
  onClick,
}: {
  label: string;
  tourId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tour={tourId}
      onClick={onClick}
      aria-haspopup="dialog"
      className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg bg-ink px-4 py-2 text-sm font-medium text-base transition-colors hover:bg-ink/90"
    >
      <PlusIcon className="size-4" />
      {label}
    </button>
  );
}

/** 44px pencil icon button that opens the edit Sheet for one list row. */
export function IconEditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title="Editar"
      className="inline-flex size-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-base"
    >
      <PencilIcon className="size-5" />
    </button>
  );
}

/**
 * 44px trash icon button bound to a delete server action (useActionState
 * dispatch). The confirm guard is client-side only: without JS the handler
 * never runs and deletion still works.
 */
export function IconDeleteButton({
  label,
  confirm,
  id,
  formAction,
  pending,
}: {
  label: string;
  confirm: string;
  id: string;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(confirm)) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        aria-label={label}
        title="Eliminar"
        className="inline-flex size-11 items-center justify-center rounded-lg text-danger-text transition-colors hover:bg-danger-soft disabled:opacity-50"
      >
        <TrashIcon className="size-5" />
      </button>
    </form>
  );
}
