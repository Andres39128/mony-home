"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard } from "@/features/auth/session";
import {
  createRecurring,
  recurringSchema,
  removeRecurring,
  toggleRecurringActive,
  updateRecurring,
} from "@/features/recurring/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";
import { amountFieldError } from "@/lib/money-errors";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar los recurrentes.";

/** Materialized rows land on /movimientos and move the dashboard totals. */
function revalidateRecurring(): void {
  revalidatePath("/recurrentes");
  revalidatePath("/movimientos");
  revalidatePath("/");
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapRecurringError(error: string): FormState {
  if (error === "invalid_amount" || error === "ambiguous_amount") {
    return amountFieldError(error);
  }
  if (error === "category_kind_mismatch") {
    return {
      fieldErrors: { categoryId: "La categoría no corresponde al tipo de movimiento." },
    };
  }
  if (error === "member_inactive") {
    return { fieldErrors: { memberId: "El integrante seleccionado está inactivo." } };
  }
  if (error === "not_found") {
    return { error: "Alguno de los datos seleccionados ya no existe. Recarga e intenta de nuevo." };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar el recurrente." };
}

function readRecurringForm(formData: FormData) {
  return {
    name: formData.get("name"),
    type: formData.get("type"),
    amount: formData.get("amount"),
    categoryId: formData.get("categoryId") ?? "",
    memberId: formData.get("memberId") ?? "",
    scope: formData.get("scope") ?? "common",
    dayOfMonth: formData.get("dayOfMonth"),
    note: formData.get("note") ?? "",
  };
}

export async function createRecurringAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = recurringSchema.safeParse(readRecurringForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createRecurring(getDb(), guard.user, parsed.data);
  if (!result.ok) return mapRecurringError(result.error);

  revalidateRecurring();
  return { ok: true };
}

export async function updateRecurringAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Recurrencia inválida." };

  const parsed = recurringSchema.safeParse(readRecurringForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateRecurring(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapRecurringError(result.error);

  revalidateRecurring();
  return { ok: true };
}

export async function toggleRecurringAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Recurrencia inválida." };

  const result = await toggleRecurringActive(getDb(), guard.user, id);
  if (!result.ok) return mapRecurringError(result.error);

  revalidateRecurring();
  return { ok: true };
}

export async function deleteRecurringAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Recurrencia inválida." };

  const result = await removeRecurring(getDb(), guard.user, id);
  if (!result.ok) return mapRecurringError(result.error);

  revalidateRecurring();
  return { ok: true };
}
