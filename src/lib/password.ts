/**
 * Password credential policy — argon2id primitives plus the failed-attempt
 * lockout constants shared by login (src/lib/auth) and the members service.
 *
 * Split from src/lib/auth so feature services can hash/verify passwords and
 * apply lockout policy without importing the session-auth core (the eslint
 * layer boundaries restrict value imports of `@/lib/auth` inside features).
 * Pure: no DB access, no framework imports.
 */
import { hash, verify } from "@node-rs/argon2";

/** Failed attempts before the account locks. */
export const MAX_FAILED_ATTEMPTS = 5;
/** Lockout window once MAX_FAILED_ATTEMPTS is reached. */
export const LOCKOUT_MS = 10 * 60 * 1000;

/** Verify a password against a stored argon2 hash (login + self-service). */
export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/** argon2id with library defaults (m=19456, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}
