"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db";
import { ForbiddenError, requireAdmin } from "@/lib/auth";
import { requireUser } from "@/features/auth/session";
import { appSettingsSchema, setAppSettings } from "@/lib/app-settings";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden cambiar la configuración.";

/**
 * Persist the household's currency/locale (Configuración page). Authorization
 * is enforced here on every call — hiding the form for members is cosmetic.
 */
export async function setAppSettingsAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  try {
    requireAdmin(user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: ADMIN_REQUIRED_MESSAGE };
    throw error;
  }

  const parsed = appSettingsSchema.safeParse({
    currencyCode: formData.get("currencyCode"),
    locale: formData.get("locale"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await setAppSettings(getDb(), user, parsed.data);
  if (!result.ok) return { error: "No se pudo guardar la configuración." };
  refresh();
  return { ok: true };
}
