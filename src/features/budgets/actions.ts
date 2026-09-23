"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard } from "@/features/auth/session";
import {
  copyFromPreviousMonth,
  setForMonth,
  type BudgetEntryInput,
} from "@/features/budgets/service";
import {
  AMBIGUOUS_AMOUNT_MESSAGE,
  INVALID_AMOUNT_MESSAGE,
  parseAmountCents,
} from "@/lib/money-errors";
import { z } from "zod";
import type { FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar el presupuesto.";

/** Inputs are named `amounts.<categoryId>`; one form covers every category. */
const AMOUNT_PREFIX = "amounts.";
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes inválido.");

function monthFrom(formData: FormData): string | null {
  const month = formData.get("month");
  return typeof month === "string" && monthSchema.safeParse(month).success ? month : null;
}

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

  const month = monthFrom(formData);
  if (!month) return { error: "El mes indicado no es válido." };

  const entries: BudgetEntryInput[] = [];
  const fieldErrors: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(AMOUNT_PREFIX)) continue;
    const raw = String(value).trim();
    // An untouched input means "no budget" (0), not a parse error.
    if (raw !== "") {
      const cents = parseAmountCents(raw);
      if (cents === "ambiguous_amount") fieldErrors[key] = AMBIGUOUS_AMOUNT_MESSAGE;
      else if (cents === "invalid_amount") fieldErrors[key] = INVALID_AMOUNT_MESSAGE;
    }
    entries.push({ categoryId: key.slice(AMOUNT_PREFIX.length), amount: raw === "" ? "0" : raw });
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const result = await setForMonth(getDb(), guard.user, month, entries);
  if (!result.ok) return budgetErrorMessage(result.error);

  revalidatePath("/presupuesto");
  return { ok: true };
}

export async function copyPreviousBudgetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const month = monthFrom(formData);
  if (!month) return { error: "El mes indicado no es válido." };

  const result = await copyFromPreviousMonth(getDb(), guard.user, month);
  if (!result.ok) return budgetErrorMessage(result.error);

  revalidatePath("/presupuesto");
  return { ok: true };
}
