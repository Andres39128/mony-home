"use client";

import { useActionState } from "react";
import type { FormState } from "@/lib/form-state";
import { FieldError, FormError, OkMessage, SubmitButton, inputClass } from "@/components/forms";
import { formatFxRate } from "@/features/savings/math";

type FxAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  /** Existing rates, sorted by code. */
  rates: { code: string; rate: number }[];
  baseCurrency: string;
  /** Members see the values read-only; the action enforces admin anyway. */
  isAdmin: boolean;
  action: FxAction;
}

/**
 * Manual FX rates (roadmap F8). One shared upsert action: the bottom form
 * adds a new code, each row's inline form rewrites its rate. Deleting is
 * deliberately absent — a wrong rate is corrected by saving the right one.
 */
export default function FxRatesForm({ rates, baseCurrency, isAdmin, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink">Tasas de cambio</h2>
        <p className="text-xs text-muted">
          Cuántas unidades de {baseCurrency} vale UNA unidad de la moneda. El
          patrimonio de las inversiones en otra moneda se convierte con esta
          tasa. Ej: USD = 3800 → US$ 100 son $ 380.000.
        </p>
      </div>

      {rates.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rates.map(({ code, rate }) => (
            <li
              key={code}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3"
            >
              <span className="w-16 font-medium text-ink">{code}</span>
              <span className="text-sm tabular-nums text-muted">
                × {formatFxRate(rate)}
              </span>
              {isAdmin && (
                <form action={formAction} className="ml-auto flex items-center gap-2">
                  <input type="hidden" name="code" value={code} />
                  <input
                    name="rate"
                    inputMode="decimal"
                    placeholder="Nueva tasa"
                    aria-label={`Nueva tasa para ${code}`}
                    className={`${inputClass} w-36`}
                  />
                  <SubmitButton pending={pending} variant="secondary">
                    Actualizar
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {rates.length === 0 && (
        <p className="text-sm text-muted">
          Todavía no hay tasas: las inversiones en otra moneda quedan sin tasa
          (cuentan a su valor de frente hasta que cargues una).
        </p>
      )}

      {isAdmin && (
        <form action={formAction} className="flex flex-col gap-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Moneda</span>
              <input
                name="code"
                required
                pattern="[A-Za-z]{3}"
                maxLength={3}
                placeholder="USD"
                title="Código de 3 letras, ej: USD"
                className={`${inputClass} w-24 uppercase`}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Tasa ({baseCurrency} por unidad)</span>
              <input
                name="rate"
                inputMode="decimal"
                required
                placeholder="3800"
                className={`${inputClass} w-40`}
              />
            </label>
            <SubmitButton pending={pending}>Guardar tasa</SubmitButton>
          </div>
          <FieldError message={state.fieldErrors?.code} />
          <FieldError message={state.fieldErrors?.rate} />
          <FormError state={state} />
          <OkMessage state={state} text="Tasa guardada." />
        </form>
      )}
    </section>
  );
}
