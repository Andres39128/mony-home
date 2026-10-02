"use server";

import { refresh } from "next/cache";
import { getDb } from "@/db";
import { ForbiddenError, requireAdmin } from "@/lib/auth";
import { requireUser } from "@/features/auth/session";
import {
  appSettingsSchema,
  fxRateSchema,
  setAppSettings,
  setFxRate,
} from "@/lib/app-settings";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden cambiar la configuración.";

/**
 * Persist the household's currency/locale (Configuración page). Authorization
 * is enforced here on every call — hiding the form for members is cosmetic.
 * Audit lives in the ACTION layer (not setAppSettings) because
 * lib/app-settings.ts is imported by the seed CLI and must stay free of
 * feature-module imports (seed resolves no `@/` aliases).
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

/** Add/rewrite one manual FX rate (Configuración → Tasas de cambio). */
export async function setFxRateAction(
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

  const parsed = fxRateSchema.safeParse({
    code: formData.get("code"),
    rate: formData.get("rate"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await setFxRate(getDb(), user, parsed.data.code, parsed.data.rate);
  if (!result.ok) {
    if (result.error === "base_currency") {
      return {
        fieldErrors: {
          code: `${parsed.data.code} ya es la moneda de la casa: no necesita tasa.`,
        },
      };
    }
    if (result.error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
    return { error: "No se pudo guardar la tasa." };
  }
  refresh();
  return { ok: true };
}
