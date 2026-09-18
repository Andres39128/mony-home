"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import {
  EditDetails,
  FieldError,
  FormError,
  OkMessage,
  SubmitButton,
  inputClass,
} from "@/components/forms";

type BudgetAction = (state: FormState, formData: FormData) => Promise<FormState>;

export interface BudgetEditorRow {
  categoryId: string;
  categoryName: string;
  plannedCents: number;
}

interface Props {
  month: string;
  rows: BudgetEditorRow[];
  setAction: BudgetAction;
  copyAction: BudgetAction;
}

/**
 * Admin editor for a whole month: ONE form carries every category's amount
 * input (replace-all semantics server-side) plus a separate copy form that
 * clones the previous month in a single action call. Collapsed by default
 * behind a native <details> so it doesn't dwarf the page on mobile.
 */
export default function BudgetEditor({ month, rows, setAction, copyAction }: Props) {
  const [state, formAction, pending] = useActionState(setAction, {});
  const [copyState, copyFormAction, copyPending] = useActionState(copyAction, {});
  const plannedTotal = rows.reduce((total, row) => total + row.plannedCents, 0);

  return (
    <EditDetails
      summary={
        <span className="text-sm font-normal text-muted">
          presupuesto del mes · {rows.length} categorías · Presupuestado:{" "}
          <span className="font-medium tabular-nums text-ink">{formatCents(plannedTotal)}</span>
        </span>
      }
    >
      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="month" value={month} />
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <label key={row.categoryId} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">{row.categoryName}</span>
              <input
                name={`amounts.${row.categoryId}`}
                defaultValue={row.plannedCents === 0 ? "" : formatCents(row.plannedCents)}
                inputMode="decimal"
                placeholder="Sin presupuestar"
                className={`${inputClass} min-h-11`}
              />
              <FieldError message={state.fieldErrors?.[`amounts.${row.categoryId}`]} />
            </label>
          ))}
        </div>
        <FormError state={state} />
        <OkMessage state={state} />
        {/* Full-width thumb-friendly CTA on mobile, inline on larger screens. */}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-ink px-4 text-sm font-medium text-base transition-colors hover:bg-ink/90 disabled:opacity-50 sm:w-auto sm:self-start"
        >
          Guardar presupuesto
        </button>
      </form>

      <form action={copyFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="month" value={month} />
        <FormError state={copyState} />
        <OkMessage state={copyState} text="Presupuestos copiados del mes anterior." />
        <SubmitButton pending={copyPending} variant="secondary">
          Copiar mes anterior
        </SubmitButton>
      </form>
    </EditDetails>
  );
}
