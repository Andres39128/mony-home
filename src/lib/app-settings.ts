/**
 * Instance-wide app settings (roadmap F1: parametrizable currency/locale),
 * backed by the app_config key/value table. The single household this app
 * serves decides its currency once (Configuración page or seed env); every
 * formatter reads it — no currency may ever be hardcoded at a call site.
 *
 * Sensible CODE-LEVEL fallbacks (COP/es-CO) keep the app resilient before
 * the seed runs or the table is missing entirely.
 */
import { cache } from "react";
import { like, sql } from "drizzle-orm";
import { z } from "zod";
// Relative on purpose: the seed CLI (`npm run db:seed`) runs plain node ESM,
// which does not resolve the `@/` alias — only Next/vitest do. Any module the
// seed imports must stay alias-free end to end.
import { appConfig } from "../db/schema.ts";
import type { Database } from "../db/index.ts";
import type { SessionUser } from "./auth.ts";
import { hasPgError } from "../db/pg-errors.ts";

export interface AppSettings {
  /** ISO 4217 code, e.g. 'COP'. */
  currencyCode: string;
  /** BCP-47 locale, e.g. 'es-CO'. */
  locale: string;
}

/** Code-level fallbacks: what the app uses before any seed/admin write. */
export const DEFAULT_APP_SETTINGS: AppSettings = { currencyCode: "COP", locale: "es-CO" };

/** Shared currency-code shape (settings, fx rates, goal currency). */
export const ISO_CURRENCY_CODE_RE = /^[A-Z]{3}$/;

/** Validation shared by the Configuración action, the service and seed env. */
export const appSettingsSchema = z.object({
  currencyCode: z
    .string()
    .trim()
    .regex(ISO_CURRENCY_CODE_RE, "Usá el código ISO de 3 letras (ej: COP)"),
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2}-[A-Z]{2}$/, "Usá el formato idioma-PAÍS (ej: es-CO)"),
});

/** Raw upsert of both keys (also used by the seed script; no auth here). */
export async function upsertAppConfig(db: Database, settings: AppSettings): Promise<void> {
  await db
    .insert(appConfig)
    .values([
      { key: "currencyCode", value: settings.currencyCode },
      { key: "locale", value: settings.locale },
    ])
    // excluded.value + now(): the whole point of the table is what and when
    // it was changed, so every write refreshes updated_at.
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
}

/**
 * Read the configured settings, once per request (React cache). Falls back
 * per-field to the code defaults when a key is missing or invalid — a
 * half-seeded or hand-edited table must never crash a render.
 */
export const getAppSettings = cache(async (db: Database): Promise<AppSettings> => {
  let rows: { key: string; value: string }[];
  try {
    rows = await db.select({ key: appConfig.key, value: appConfig.value }).from(appConfig);
  } catch (error) {
    // 42P01 undefined_table: migration not applied yet (fresh deploy) —
    // defaults instead of a crashed request.
    if (hasPgError(error, "42P01")) return DEFAULT_APP_SETTINGS;
    throw error;
  }
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const currencyCode = appSettingsSchema.shape.currencyCode.safeParse(byKey.get("currencyCode"));
  const locale = appSettingsSchema.shape.locale.safeParse(byKey.get("locale"));
  return {
    currencyCode: currencyCode.success ? currencyCode.data : DEFAULT_APP_SETTINGS.currencyCode,
    locale: locale.success ? locale.data : DEFAULT_APP_SETTINGS.locale,
  };
});

export type AppSettingsMutationError = "forbidden" | "invalid_input";

/** Admin-only write of both settings; validates before touching the table. */
export async function setAppSettings(
  db: Database,
  user: SessionUser,
  input: { currencyCode: string; locale: string },
): Promise<{ ok: true } | { ok: false; error: AppSettingsMutationError }> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const parsed = appSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  await upsertAppConfig(db, parsed.data);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Manual FX rates (roadmap F8) — same key/value table, no schema change.
// ---------------------------------------------------------------------------

/** app_config key prefix for FX rates: 'fx:USD' = one US dollar's worth. */
export const FX_KEY_PREFIX = "fx:";

/**
 * DIRECTION (the one rule to remember): `fx:USD = 3800` means ONE unit of
 * USD is worth 3800 units of the BASE currency — i.e. the rate MULTIPLIES a
 * foreign amount into base. Rates are decimal multipliers, NOT cents: they
 * are stored as dot-decimal strings exactly as validated ("3800.5"), and
 * consumers convert with Math.round(cents × rate) — float64 handles the
 * products, the round absorbs sub-cent drift.
 */
export const FX_RATE_RE = /^[0-9]+([.,][0-9]+)?$/;

/** Stored form of a validated rate: dot-decimal, as typed. */
export function normalizeFxRate(rate: string): string {
  return rate.replace(",", ".");
}

/** Validation shared by the Configuración action and the service. */
export const fxRateSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(ISO_CURRENCY_CODE_RE, "Usá el código de 3 letras (ej: USD)"),
  rate: z
    .string()
    .trim()
    .regex(FX_RATE_RE, "Usá un número positivo (ej: 3800 o 3800,5)")
    // The regex alone admits "0"; a zero/empty rate is meaningless.
    .refine((r) => Number(normalizeFxRate(r)) > 0, "La tasa debe ser mayor a cero"),
});

export type FxRateMutationError = "forbidden" | "invalid_input" | "base_currency";

/**
 * Every stored FX rate keyed by currency code ('USD' → 3800.5). One read
 * per request (React cache — patrimony and the settings page share it).
 * Hand-edited garbage degrades silently: rows with invalid codes or
 * non-numeric/non-positive values are skipped, never crash a render.
 */
export const getFxRates = cache(async (db: Database): Promise<Record<string, number>> => {
  let rows: { key: string; value: string }[];
  try {
    rows = await db
      .select({ key: appConfig.key, value: appConfig.value })
      .from(appConfig)
      .where(like(appConfig.key, `${FX_KEY_PREFIX}%`));
  } catch (error) {
    // 42P01 undefined_table: pre-migration deploy — no rates instead of a crash.
    if (hasPgError(error, "42P01")) return {};
    throw error;
  }
  const rates: Record<string, number> = {};
  for (const row of rows) {
    const code = row.key.slice(FX_KEY_PREFIX.length);
    const rate = Number(row.value);
    if (ISO_CURRENCY_CODE_RE.test(code) && Number.isFinite(rate) && rate > 0) {
      rates[code] = rate;
    }
  }
  return rates;
});

/** Admin-only upsert of one rate; refuses the base currency (a base 'fx:' key is meaningless). */
export async function setFxRate(
  db: Database,
  user: SessionUser,
  code: string,
  rate: string,
): Promise<{ ok: true } | { ok: false; error: FxRateMutationError }> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const parsed = fxRateSchema.safeParse({ code, rate });
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  const settings = await getAppSettings(db);
  if (settings.currencyCode === parsed.data.code) return { ok: false, error: "base_currency" };
  await db
    .insert(appConfig)
    .values({ key: `${FX_KEY_PREFIX}${parsed.data.code}`, value: normalizeFxRate(parsed.data.rate) })
    // Same contract as upsertAppConfig: every write refreshes updated_at.
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
    });
  return { ok: true };
}
