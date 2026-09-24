"use server";

import { z } from "zod";
import { getDb } from "@/db";
import { adminGuard, requireUser } from "@/features/auth/session";
import {
  expenseGroupSchema,
  createExpenseGroup,
  removeExpenseGroup,
  setExpenseGroupStatus,
  updateExpenseGroup,
} from "@/features/expense-groups/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden modificar grupos.";

function readGroupForm(formData: FormData) {
  return {
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  };
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapGroupError(error: string): FormState {
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar el grupo." };
}

/** Open to any authenticated member. */
export async function createExpenseGroupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();

  const parsed = expenseGroupSchema.safeParse(readGroupForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createExpenseGroup(getDb(), parsed.data);
  if (!result.ok) return mapGroupError(result.error);
  return { ok: true };
}

export async function updateExpenseGroupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Grupo inválido." };

  const parsed = expenseGroupSchema.safeParse(readGroupForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateExpenseGroup(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapGroupError(result.error);
  return { ok: true };
}

const statusSchema = z.enum(["active", "closed"]);

export async function setExpenseGroupStatusAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Grupo inválido." };

  const parsed = statusSchema.safeParse(formData.get("status"));
  if (!parsed.success) return { error: "Estado inválido." };

  const result = await setExpenseGroupStatus(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapGroupError(result.error);
  return { ok: true };
}

export async function deleteExpenseGroupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Grupo inválido." };

  const result = await removeExpenseGroup(getDb(), guard.user, id);
  if (!result.ok) return mapGroupError(result.error);
  return { ok: true };
}
