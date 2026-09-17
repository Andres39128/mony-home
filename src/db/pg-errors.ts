/**
 * Match a Postgres error code on the error or its cause (drizzle wraps driver
 * errors, so the code may sit one level deep). Test-side mirror of this
 * contract lives in test-utils.expectPgError.
 */
export function hasPgError(error: unknown, code: string): boolean {
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === code || err.cause?.code === code;
}
