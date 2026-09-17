"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { ForbiddenError, requireAdmin } from "@/lib/auth";
import { requireUser } from "@/features/auth/session";
import {
  createMember,
  createMemberSchema,
  deleteMember,
  updateMember,
  updateMemberSchema,
  type MemberFormState,
} from "@/features/members/service";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar integrantes.";

/**
 * Authorization gate shared by every mutating action.
 * UI hiding is never trusted: the guard runs server-side on each call.
 */
async function requireAdminOrError(): Promise<MemberFormState | null> {
  try {
    requireAdmin(await requireUser());
    return null;
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: ADMIN_REQUIRED_MESSAGE };
    throw error;
  }
}

function fieldErrorsFrom(issues: { path: (string | number | symbol)[]; message: string }[]): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "");
    fieldErrors[key] ??= issue.message;
  }
  return fieldErrors;
}

export async function createMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const denied = await requireAdminOrError();
  if (denied) return denied;

  const parsed = createMemberSchema.safeParse({
    username: formData.get("username"),
    name: formData.get("name"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createMember(getDb(), parsed.data);
  if (!result.ok) {
    if (result.error === "username_taken") {
      return { fieldErrors: { username: "Ese nombre de usuario ya existe." } };
    }
    return { error: "No se pudo crear el integrante." };
  }

  revalidatePath("/integrantes");
  return { ok: true };
}

export async function updateMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const denied = await requireAdminOrError();
  if (denied) return denied;

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) return { error: "Integrante inválido." };

  const parsed = updateMemberSchema.safeParse({
    name: formData.get("name"),
    role: formData.get("role"),
    isActive: formData.get("isActive") === "on",
    newPassword: formData.get("newPassword") ?? "",
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateMember(getDb(), id, parsed.data);
  if (!result.ok) return { error: "No se pudo guardar el integrante." };

  revalidatePath("/integrantes");
  return { ok: true };
}

export async function deleteMemberAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const denied = await requireAdminOrError();
  if (denied) return denied;

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) return { error: "Integrante inválido." };

  const result = await deleteMember(getDb(), id);
  if (!result.ok) {
    if (result.error === "has_movements") {
      return {
        error: "No se puede eliminar: tiene movimientos asociados. Podés desactivarlo.",
      };
    }
    return { error: "No se pudo eliminar el integrante." };
  }

  revalidatePath("/integrantes");
  return { ok: true };
}
