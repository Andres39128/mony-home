"use client";

import type { ReactNode } from "react";
import type { FormState } from "@/lib/form-state";

/**
 * Small form feedback primitives shared by every admin CRUD panel.
 * Extracted after appearing verbatim in three or more panels.
 */

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:border-zinc-100";

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-600 dark:text-red-400">{message}</p>;
}

export function FormError({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {state.error}
    </p>
  );
}

export function OkMessage({ state, text = "Cambios guardados." }: { state: FormState; text?: string }) {
  if (!state.ok) return null;
  return (
    <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
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
      ? "border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      : variant === "secondary"
        ? "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`self-start rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${variantClass}`}
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
          ? "rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
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
    <details className="group rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-6 py-4 font-medium text-zinc-900 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden dark:text-zinc-50 dark:hover:bg-zinc-800/50">
        <span
          aria-hidden
          className="inline-block shrink-0 text-xs text-zinc-500 transition-transform group-open:rotate-90 dark:text-zinc-400"
        >
          ▸
        </span>
        <span className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          Editar
        </span>
        {summary}
      </summary>
      <div className="flex flex-col gap-4 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
        {children}
      </div>
    </details>
  );
}
