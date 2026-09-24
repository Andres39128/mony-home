"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { ForbiddenError, hashToken, requireAdmin } from "@/lib/auth";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { requireUser } from "@/features/auth/session";
import {
  changeOwnPassword,
  createMember,
  createMemberSchema,
  deleteMember,
  ownNameSchema,
  ownPasswordSchema,
  updateMember,
  updateMemberSchema,
  updateOwnName,
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

/**
 * Self-service actions for the Perfil page. Only the current user is ever
 * touched (requireUser), so a member can never modify someone else's row.
 */
export async function changeOwnPasswordAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const user = await requireUser();

  const parsed = ownPasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  // Typo guard: the repeat field must match the new password exactly.
  const repeat = formData.get("repeatPassword");
  if (repeat !== parsed.data.newPassword) {
    return { fieldErrors: { repeatPassword: "Las contraseñas no coinciden." } };
  }

  // Revoke every OTHER session on rotation: the current cookie stays valid
  // (its SHA-256 is the exception), any stolen token dies with the hash.
  const currentToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const result = await changeOwnPassword(
    getDb(),
    user.id,
    parsed.data.currentPassword,
    parsed.data.newPassword,
    currentToken ? hashToken(currentToken) : undefined,
  );
  if (!result.ok) {
    if (result.error === "wrong_current_password") {
      return { fieldErrors: { currentPassword: "La contraseña actual no es correcta." } };
    }
    if (result.error === "locked") {
      return {
        error: "Cuenta bloqueada temporalmente. Esperá unos minutos y volvé a intentar.",
      };
    }
    if (result.error === "invalid_password") {
      return {
        fieldErrors: { newPassword: "La nueva contraseña debe tener al menos 8 caracteres." },
      };
    }
    return { error: "No se pudo cambiar la contraseña." };
  }

  revalidatePath("/perfil");
  return { ok: true };
}

export async function updateOwnNameAction(
  _prev: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  const user = await requireUser();

  const parsed = ownNameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateOwnName(getDb(), user.id, parsed.data.name);
  if (!result.ok) return { error: "No se pudo guardar el nombre." };

  revalidatePath("/perfil");
  return { ok: true };
}
