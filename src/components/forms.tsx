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
