import { z } from "zod";

/**
 * Environment configuration for mony-home.
 *
 * Parsing is LAZY: `getConfig()` parses and caches `process.env` on first
 * access. This keeps `next build` working in CI where optional variables
 * (database, LLM keys) are not set, while still failing fast — with an
 * actionable error naming each offending variable — as soon as the config
 * is actually used with an invalid state.
 */
const envSchema = z.object({
  /** Postgres connection string used by the app (Supabase pooler). Optional until the DB phase lands. */
  DATABASE_URL: z.string().url().optional(),
  /** Direct (non-pooled) Postgres connection string, reserved for migrations. */
  DIRECT_URL: z.string().url().optional(),
  /** Base URL of the OpenAI-compatible LLM endpoint. Defaults to OpenRouter. */
  LLM_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  /** OpenRouter API key. Optional until the assistant phase lands. */
  LLM_API_KEY: z.string().min(1).optional(),
  /** Model identifier for the finance assistant (e.g. an OpenRouter free-tier model). */
  LLM_MODEL: z.string().min(1).optional(),
  /** Max assistant requests per user per day. Must be a positive integer. */
  ASSISTANT_DAILY_LIMIT: z.coerce.number().int().positive().default(8),
  /** Human-readable app name; later sent to OpenRouter as the X-Title attribution header. */
  APP_NAME: z.string().min(1).default("mony-home"),
  /**
   * Currency the household's instance runs in (ISO 4217, 3 letters). Seeded
   * into app_config by `npm run db:seed`; the admin Configuración page can
   * change it afterwards. This is a seed-time default only — the DB row wins.
   */
  APP_CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/, "Usá el código ISO de 3 letras (ej: COP)")
    .default("COP"),
  /** BCP-47 locale used to format amounts/dates alongside APP_CURRENCY. */
  APP_LOCALE: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/, "Usá el formato idioma-PAÍS (ej: es-CO)")
    .default("es-CO"),
  /**
   * Password (pre-hash) assigned to the seeded admin user by `npm run db:seed`.
   * Optional (seeding is a manual step), with NO default. Strength and
   * placeholder rejection are enforced by the seed script itself (PLACEHOLDER
   * + length guards in src/db/seed.ts): a bad value is a seed-only concern
   * and must not fail every runtime request path through the shared schema.
   */
  SEED_ADMIN_PASSWORD: z.string().optional(),
  /**
   * Seed scope for `npm run db:seed`. `false` = production bootstrap: only
   * categories + the admin user. Anything else keeps full demo seeding.
   * Parsed as an enum instead of `z.coerce.boolean()`, which would turn the
   * string "false" into `true`.
   */
  SEED_DEMO_DATA: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type AppConfig = z.infer<typeof envSchema>;
/** Structural env source; `process.env` satisfies this without dragging in @types/node's required NODE_ENV. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse the given environment source against the schema.
 * Throws an Error listing every missing/invalid variable when parsing fails.
 */
export function loadConfig(source: EnvSource = process.env): AppConfig {
  // Blank placeholders ('' / whitespace) in .env templates count as unset,
  // so optional variables don't fail validation when left empty.
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string" && value.trim() === "" ? undefined : value,
    ]),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Fix these variables before starting the app:\n${details}\nSee .env.example for documentation.`,
    );
  }
  return result.data;
}

let cached: AppConfig | undefined;

/**
 * Lazily parsed, cached application config.
 * Safe to call during runtime request handling; do not call at module top
 * level of files imported during `next build` unless the variables used are
 * guaranteed present.
 */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
