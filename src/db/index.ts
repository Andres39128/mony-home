/**
 * Application database client (postgres.js) — request-time singleton.
 *
 * Kept lazy so importing this module never opens a connection; the driver is
 * created on first `getDb()` call. Tests use PGlite via src/db/test-utils.ts
 * and cast to `Database` (the drivers are structurally identical at runtime,
 * only their TS generics differ).
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "@/lib/config";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let cached: { db: Database; client: postgres.Sql } | undefined;

export function getDb(): Database {
  cached ??= createDb();
  return cached.db;
}

function createDb(): { db: Database; client: postgres.Sql } {
  const config = getConfig();
  if (!config.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run the app. See .env.example.");
  }
  // dep: postgres — already the project's wire driver (seed + migrations).
  const client = postgres(config.DATABASE_URL);
  return { db: drizzle(client, { schema }), client };
}

/** Close the pooled connection (used by graceful shutdown paths). */
export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.client.end();
    cached = undefined;
  }
}
