"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { formatCents } from "@/lib/money";
import { FieldError, FormError, OkMessage, SubmitButton, inputClass } from "@/components/forms";

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
 * clones the previous month in a single action call.
 */
export default function BudgetEditor({ month, rows, setAction, copyAction }: Props) {
  const [state, formAction, pending] = useActionState(setAction, {});
  const [copyState, copyFormAction, copyPending] = useActionState(copyAction, {});

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
      <h2 className="font-semibold text-ink">Editar presupuestos</h2>

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="month" value={month} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => (
            <label key={row.categoryId} className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">{row.categoryName}</span>
              <input
                name={`amounts.${row.categoryId}`}
                defaultValue={row.plannedCents === 0 ? "" : formatCents(row.plannedCents)}
                inputMode="decimal"
                placeholder="Sin presupuestar"
                className={inputClass}
              />
              <FieldError message={state.fieldErrors?.[`amounts.${row.categoryId}`]} />
            </label>
          ))}
        </div>
        <FormError state={state} />
        <OkMessage state={state} />
        <SubmitButton pending={pending}>Guardar presupuesto</SubmitButton>
      </form>

      <form action={copyFormAction} className="flex flex-col gap-2 border-t border-line pt-4">
        <input type="hidden" name="month" value={month} />
        <FormError state={copyState} />
        <OkMessage state={copyState} text="Presupuestos copiados del mes anterior." />
        <SubmitButton pending={copyPending} variant="secondary">
          Copiar mes anterior
        </SubmitButton>
      </form>
    </section>
  );
}
