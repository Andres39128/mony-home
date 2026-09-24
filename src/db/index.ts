import "server-only";
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
  // Pooled Supabase (Supavisor) caps clients hard (session pool_size: 15), and
  // serverless lambdas freeze while holding sockets, so the pool must stay
  // small and release idle connections instead of using the default max: 10.
  // ponytail: ceiling — max:3 per lambda × N concurrent lambdas bounds the
  // total pooler clients (Supabase/Supavisor caps clients). If exhaustion ever
  // appears, lower max or serialize reads per request — do not raise blindly.
  const client = postgres(config.DATABASE_URL, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Supavisor transaction-mode pooler (port 6543) breaks named prepared statements.
    prepare: false,
  });
  return { db: drizzle(client, { schema }), client };
}

/** Close the pooled connection (used by graceful shutdown paths). */
export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.client.end();
    cached = undefined;
  }
}
