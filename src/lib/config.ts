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
  /** Secret for signing sessions once auth lands. */
  AUTH_SECRET: z.string().min(1).optional(),
  /** Password (pre-hash) assigned to seeded demo users by `npm run db:seed`. */
  SEED_ADMIN_PASSWORD: z.string().min(1).default("changeme-on-first-login"),
});

export type AppConfig = z.infer<typeof envSchema>;
/** Structural env source; `process.env` satisfies this without dragging in @types/node's required NODE_ENV. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse the given environment source against the schema.
 * Throws an Error listing every missing/invalid variable when parsing fails.
 */
export function loadConfig(source: EnvSource = process.env): AppConfig {
  const result = envSchema.safeParse(source);
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
