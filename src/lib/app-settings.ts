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
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import { appConfig } from "@/db/schema";
import type { SessionUser } from "@/lib/auth";
import { hasPgError } from "@/db/pg-errors";

/**
 * Any Postgres drizzle database — the app pool in production, PGlite in
 * tests, postgres-js in the seed CLI (same loose contract as src/db/seed.ts).
 */
type SettingsDb = PgDatabase<PgQueryResultHKT>;

export interface AppSettings {
  /** ISO 4217 code, e.g. 'COP'. */
  currencyCode: string;
  /** BCP-47 locale, e.g. 'es-CO'. */
  locale: string;
}

/** Code-level fallbacks: what the app uses before any seed/admin write. */
export const DEFAULT_APP_SETTINGS: AppSettings = { currencyCode: "COP", locale: "es-CO" };

/** Validation shared by the Configuración action, the service and seed env. */
export const appSettingsSchema = z.object({
  currencyCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Usá el código ISO de 3 letras (ej: COP)"),
  locale: z
    .string()
    .trim()
    .regex(/^[a-z]{2}-[A-Z]{2}$/, "Usá el formato idioma-PAÍS (ej: es-CO)"),
});

/** Raw upsert of both keys (also used by the seed script; no auth here). */
export async function upsertAppConfig(db: SettingsDb, settings: AppSettings): Promise<void> {
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
export const getAppSettings = cache(async (db: SettingsDb): Promise<AppSettings> => {
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
  db: SettingsDb,
  user: SessionUser,
  input: { currencyCode: string; locale: string },
): Promise<{ ok: true } | { ok: false; error: AppSettingsMutationError }> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const parsed = appSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid_input" };
  await upsertAppConfig(db, parsed.data);
  return { ok: true };
}
