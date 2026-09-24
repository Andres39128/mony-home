"use server";

import { getDb } from "@/db";
import { adminGuard } from "@/features/auth/session";
import { copyFromPreviousMonth, setForMonth } from "@/features/budgets/service";
import { parseBudgetForm } from "@/features/budgets/form-parse";
import type { FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar el presupuesto.";

function budgetErrorMessage(error: string): FormState {
  switch (error) {
    case "invalid_month":
      return { error: "El mes indicado no es válido." };
    case "invalid_amount":
      return { error: "Hay montos con formato inválido." };
    case "category_kind_mismatch":
      return { error: "Solo se pueden presupuestar categorías de gasto." };
    case "category_inactive":
      return { error: "Hay categorías inactivas; no se pueden presupuestar." };
    case "not_found":
      return { error: "Una categoría del formulario ya no existe. Recargá la página." };
    case "nothing_to_copy":
      return { error: "El mes anterior no tiene presupuestos para copiar." };
    case "forbidden":
      return { error: ADMIN_REQUIRED_MESSAGE };
    default:
      return { error: "No se pudo guardar el presupuesto." };
  }
}

export async function setBudgetsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = parseBudgetForm(formData);
  if (!parsed.ok) {
    return "fieldErrors" in parsed ? { fieldErrors: parsed.fieldErrors } : { error: parsed.error };
  }

  const result = await setForMonth(getDb(), guard.user, parsed.month, parsed.entries);
  if (!result.ok) return budgetErrorMessage(result.error);
  return { ok: true };
}

export async function copyPreviousBudgetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = parseBudgetForm(formData);
  if (!parsed.ok) {
    return "fieldErrors" in parsed ? { fieldErrors: parsed.fieldErrors } : { error: parsed.error };
  }

  const result = await copyFromPreviousMonth(getDb(), guard.user, parsed.month);
  if (!result.ok) return budgetErrorMessage(result.error);
  return { ok: true };
}
