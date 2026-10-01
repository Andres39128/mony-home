"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { FieldError, FormError, OkMessage, SubmitButton, inputClass } from "@/components/forms";

type OpeningBalanceAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  /** Preformatted current adjustment ("-$ 30.000,00 · 10 de agosto..."), or null. */
  current: { signedLabel: string; dateLabel: string } | null;
  /** Server 'today' for the date default and max (no future filings). */
  serverToday: string;
  action: OpeningBalanceAction;
}

/**
 * Admin card: the household's opening balance lives as ONE signed adjustment
 * movement ("Saldo inicial"); saving again rewrites that same row.
 */
export default function OpeningBalanceCard({ current, serverToday, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-ink">Saldo inicial</h2>
      {current ? (
        <p className="text-sm text-muted">
          Ajuste vigente:{" "}
          <span className="font-medium text-ink">
            {current.signedLabel} · {current.dateLabel}
          </span>
        </p>
      ) : (
        <p className="text-sm text-muted">
          Todavía no hay ajuste: el saldo de la app arranca desde cero.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Monto (con signo)</span>
          <input
            name="amount"
            inputMode="decimal"
            required
            placeholder="1.500.000,00 o -$ 250.000,00"
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.amount} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-muted">Fecha</span>
          <input
            type="date"
            name="date"
            required
            defaultValue={serverToday}
            max={serverToday}
            className={inputClass}
          />
          <FieldError message={state.fieldErrors?.date} />
        </label>
      </div>
      <p className="text-xs text-muted">
        Cuenta como ingreso/gasto del mes en que lo feches — fechalo en un mes tranquilo si no
        querés inflar el actual.
      </p>
      <FormError state={state} />
      <OkMessage state={state} text="Saldo inicial actualizado." />
      <SubmitButton pending={pending}>Guardar saldo inicial</SubmitButton>
    </form>
  );
}
