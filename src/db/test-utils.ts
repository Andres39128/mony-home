import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { users } from "./schema";
import type { SessionUser } from "@/lib/auth";

/**
 * In-memory Postgres (PGlite) with the REAL generated migrations applied.
 * Each call returns an isolated database so test files never share state.
 */
export async function createTestDb(): Promise<{ db: PgliteDatabase; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client);
  // PGlite is single-tenant and does NOT auto-create the Supabase API roles
  // (anon, authenticated, authenticator). Migration 0014 references them in
  // CREATE POLICY ... TO anon, authenticated, so we materialize them here
  // before applying migrations — keeps the test env representative of the
  // production Supabase role layout. The app still connects as the PGlite
  // superuser, so RLS bypass continues to apply inside the test.
  await client.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
  `);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
  });
  return { db, client };
}

/**
 * The canonical admin+member user pair shared by the service suites
 * (identical username/name/role everywhere; passwordHash is a placeholder —
 * these users never log in). Returns SessionUser-shaped rows so each suite
 * binds its own locals (member ids, extra users) on top.
 */
export async function seedUsers(db: PgliteDatabase): Promise<{
  admin: SessionUser;
  member: SessionUser;
}> {
  const [adminRow, memberRow] = await db
    .insert(users)
    .values([
      { username: "admin", name: "Admin", passwordHash: "x", role: "admin" },
      { username: "mate", name: "Mate", passwordHash: "x", role: "member" },
    ])
    .returning();
  return {
    admin: { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: adminRow.role },
    member: { id: memberRow.id, username: memberRow.username, name: memberRow.name, role: memberRow.role },
  };
}

/**
 * Assert that a rejected promise failed with a specific Postgres error code
 * (e.g. 23514 check_violation, 23503 foreign_key_violation, 23505 unique_violation).
 * Drizzle wraps driver errors, so the code may sit on the error or its cause.
 */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const err = error as { code?: string; cause?: { code?: string } };
    if (err.code === code || err.cause?.code === code) return;
    throw error;
  }
  throw new Error(`Expected promise to reject with Postgres error ${code}, but it resolved.`);
}
