"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard, requireUser } from "@/features/auth/session";
import {
  addContribution,
  contributionSchema,
  createGoal,
  goalSchema,
  removeGoal,
  toggleGoalActive,
  updateGoal,
  updateGoalValue,
} from "@/features/savings/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar metas.";

/** Goal and contribution mutations both change /ahorro and the dashboard KPI. */
function revalidateSavings(): void {
  revalidatePath("/ahorro");
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
  if (error === "member_not_found") {
    return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
  }
  if (error === "goal_not_found") {
    return { error: "La meta no existe." };
  }
  if (error === "has_contributions") {
    return {
      error:
        "No se puede eliminar: tiene aportes asociados. Se puede desactivar como alternativa.",
    };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar la meta." };
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
  if (!id) return { error: "Meta inválida." };

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
  if (!id) return { error: "Meta inválida." };

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
  if (!id) return { error: "Meta inválida." };

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
  if (!id) return { error: "Meta inválida." };

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
  if (!goalId) return { error: "Meta inválida." };

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
    if (result.error === "goal_not_found") return { error: "La meta no existe." };
    if (result.error === "goal_inactive") {
      return { error: "La meta está inactiva: activala para registrar aportes." };
    }
    if (result.error === "member_not_found") {
      return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
    }
    return { error: "No tenés permiso para registrar ese aporte." };
  }

  revalidateSavings();
  return { ok: true };
}
