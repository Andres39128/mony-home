/**
 * Match a Postgres error code on the error or its cause (drizzle wraps driver
 * errors once, so the code may sit one level deep; postgres.js carries it
 * directly on the error). Test-side mirror of this contract lives in
 * test-utils.expectPgError.
 */
export function hasPgError(error: unknown, code: string): boolean {
  const err = (error ?? {}) as { code?: string; cause?: { code?: string } };
  return err.code === code || err.cause?.code === code;
}

/**
 * FK violation that blocks a DELETE. Postgres reports these under two codes
 * depending on version/driver path: 23001 restrict_violation (PGlite, PG <= 16)
 * and 23503 foreign_key_violation (PG 17 reports RESTRICT deletes with this
 * code — verified in production logs on Supabase PG 17).
 */
export function hasPgFkError(error: unknown): boolean {
  return hasPgError(error, "23001") || hasPgError(error, "23503");
}
