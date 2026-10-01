"use client";

import { useActionState } from "react";
import type { AppSettings } from "@/lib/app-settings";
import type { FormState } from "@/lib/form-state";
import { FieldError, FormError, OkMessage, SubmitButton, inputClass } from "@/components/forms";

type SettingsAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface Props {
  /** Current configured values, shown as the starting point of the form. */
  current: AppSettings;
  /** Members see the values read-only; the action enforces admin anyway. */
  isAdmin: boolean;
  action: SettingsAction;
}

/**
 * Household currency/locale settings. One text input per value (validated by
 * the server action); native pattern attributes give instant feedback without
 * duplicating the zod rules in JS.
 */
export default function ConfigForm({ current, isAdmin, action }: Props) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-2xl border border-line bg-surface px-6 py-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-ink">Moneda y formato</h2>
      {isAdmin ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">
                Moneda en la que vive la app (ej: COP)
              </span>
              <input
                name="currencyCode"
                defaultValue={current.currencyCode}
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                title="Código ISO de 3 letras, ej: COP"
                className={`${inputClass} uppercase`}
              />
              <FieldError message={state.fieldErrors?.currencyCode} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Localidad (formato de montos)</span>
              <input
                name="locale"
                defaultValue={current.locale}
                required
                pattern="[a-z]{2}-[A-Z]{2}"
                maxLength={5}
                title="Formato idioma-PAÍS, ej: es-CO"
                className={inputClass}
              />
              <FieldError message={state.fieldErrors?.locale} />
            </label>
          </div>
          <p className="text-xs text-muted">
            Los movimientos guardados no cambian: esto define cómo la app muestra los montos
            (símbolo, separadores y decimales). Ej: 1.500.000,00 con es-CO.
          </p>
          <FormError state={state} />
          <OkMessage state={state} text="Configuración guardada." />
          <SubmitButton pending={pending}>Guardar configuración</SubmitButton>
        </>
      ) : (
        <p className="text-sm text-muted">
          Moneda actual: <span className="font-medium text-ink">{current.currencyCode}</span> ·
          Localidad: <span className="font-medium text-ink">{current.locale}</span>. Solo los
          administradores pueden cambiarla.
        </p>
      )}
    </form>
  );
}
