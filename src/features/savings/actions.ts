"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard, requireUser } from "@/features/auth/session";
import {
  addContribution,
  contributionSchema,
  createGoal,
  goalSchema,
  markRateReviewed,
  removeGoal,
  toggleGoalActive,
  updateGoal,
  updateGoalValue,
} from "@/features/savings/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar bolsas.";

/** Goal and contribution mutations both change /bolsas and the dashboard KPI. */
function revalidateSavings(): void {
  revalidatePath("/bolsas");
  revalidatePath("/");
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapGoalError(error: string): FormState {
  if (error === "invalid_target") {
    return { fieldErrors: { target: "El objetivo no es válido." } };
  }
  if (error === "invalid_current_value") {
    return { fieldErrors: { currentValue: "El valor actual no es válido." } };
  }
  if (error === "invalid_rate") {
    return { fieldErrors: { annualRate: "La TNA no es válida (máximo 1000%)." } };
  }
  if (error === "member_not_found") {
    return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
  }
  if (error === "goal_not_found") {
    return { error: "La bolsa no existe." };
  }
  if (error === "has_contributions") {
    return {
      error:
        "No se puede eliminar: tiene aportes asociados. Se puede desactivar como alternativa.",
    };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar la bolsa." };
}

function readGoalForm(formData: FormData) {
  return {
    name: formData.get("name"),
    kind: formData.get("kind"),
    scope: formData.get("scope"),
    memberId: formData.get("memberId") ?? "",
    target: formData.get("target") ?? "",
    deadline: formData.get("deadline") ?? "",
    currentValue: formData.get("currentValue") ?? "",
    institution: formData.get("institution") ?? "",
    annualRate: formData.get("annualRate") ?? "",
    accrualMode: formData.get("accrualMode") ?? "",
  };
}

export async function createGoalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = goalSchema.safeParse(readGoalForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createGoal(getDb(), guard.user, parsed.data);
  if (!result.ok) return mapGoalError(result.error);

  revalidateSavings();
  return { ok: true };
}

export async function updateGoalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const parsed = goalSchema.safeParse(readGoalForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateGoal(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapGoalError(result.error);

  revalidateSavings();
  return { ok: true };
}

export async function toggleGoalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const result = await toggleGoalActive(getDb(), guard.user, id);
  if (!result.ok) return mapGoalError(result.error);

  revalidateSavings();
  return { ok: true };
}

export async function deleteGoalAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const result = await removeGoal(getDb(), guard.user, id);
  if (!result.ok) return mapGoalError(result.error);

  revalidateSavings();
  return { ok: true };
}

export async function updateGoalValueAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Bolsa inválida." };

  const result = await updateGoalValue(
    getDb(),
    guard.user,
    id,
    String(formData.get("currentValue") ?? ""),
  );
  if (!result.ok) {
    if (result.error === "invalid_current_value") {
      return { fieldErrors: { currentValue: "El valor actual no es válido." } };
    }
    if (result.error === "not_investment") {
      return { error: "Solo las inversiones llevan valor actual." };
    }
    return mapGoalError(result.error);
  }

  revalidateSavings();
  return { ok: true };
}

export async function addContributionAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Any authenticated member may contribute; the service pins attribution.
  const user = await requireUser();

  const goalId = idFrom(formData);
  if (!goalId) return { error: "Bolsa inválida." };

  const parsed = contributionSchema.safeParse({
    amount: formData.get("amount"),
    kind: formData.get("kind"),
    date: formData.get("date") ?? "",
    note: formData.get("note") ?? "",
    // Quick-entry forms pin to the actor; admins may send memberId explicitly.
    memberId: formData.get("memberId") ?? "",
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await addContribution(getDb(), user, goalId, parsed.data);
  if (!result.ok) {
    if (result.error === "invalid_amount") {
      return { fieldErrors: { amount: "El monto no es válido." } };
    }
    if (result.error === "goal_not_found") return { error: "La bolsa no existe." };
    if (result.error === "goal_inactive") {
      return { error: "La bolsa está inactiva: activala para registrar aportes." };
    }
    if (result.error === "member_not_found") {
      return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
    }
    if (result.error === "system_category_missing") {
      return {
        error:
          "Faltan las categorías de ahorro del sistema: ejecutá la carga inicial (db:seed) para crearlas.",
      };
    }
    return { error: "No tenés permiso para registrar ese aporte." };
  }

  revalidateSavings();
  return { ok: true };
}

/**
 * Review banner action: stamps rate_reviewed_month = current month on every
 * pending rate-bearing bolsa (admin-only) so the banner clears.
 */
export async function markRateReviewedAction(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- action takes no fields
  _prev: FormState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- action takes no fields
  _formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const result = await markRateReviewed(getDb(), guard.user);
  if (!result.ok) return mapGoalError(result.error);

  revalidateSavings();
  return { ok: true };
}
