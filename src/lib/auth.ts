/**
 * Session authentication core — hand-rolled on purpose.
 *
 * Design (phase 2 decision): argon2id password verification plus random
 * DB-backed sessions. All cryptography lives in libraries (@node-rs/argon2,
 * node:crypto); this module only implements the well-understood session
 * pattern. Cookie side-effects (next/headers) are kept OUT of here so the
 * whole module is testable against an in-memory Postgres with an injected
 * clock — see src/features/auth/session.ts for the Next.js glue.
 *
 * Security notes:
 * - Only SHA-256(token) is stored; the raw token never touches the DB.
 * - Unknown usernames run a dummy argon2 verify so response timing does not
 *   reveal whether an account exists.
 * - Lockout state lives on the user row; while locked, credentials are never
 *   verified.
 * - Failed logins are also rate limited per client IP (login_ip_attempts):
 *   the gate runs before the account lookup, complementing the per-account
 *   lockout for attacks that rotate usernames.
 */
import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import { loginIpAttempts, sessions, users, type roleEnum } from "@/db/schema";
import type { Database } from "@/db";

/** Cookie name; isolated in this module's public surface for the edge proxy. */
export const SESSION_COOKIE_NAME = "mony_session";

/** How long a session (and its cookie) lives: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Failed attempts before the account locks. */
export const MAX_FAILED_ATTEMPTS = 5;
/** Lockout window once MAX_FAILED_ATTEMPTS is reached. */
export const LOCKOUT_MS = 10 * 60 * 1000;

/** Failed logins allowed per IP before the IP is shut out of login. */
export const MAX_IP_ATTEMPTS = 10;
/** Sliding window over which login_ip_attempts rows count against an IP. */
export const IP_WINDOW_MS = 15 * 60 * 1000;
/** Rows older than this are pruned opportunistically after failed attempts. */
export const IP_ATTEMPT_RETENTION_MS = 60 * 60 * 1000;

export type UserRole = (typeof roleEnum.enumValues)[number];

export interface SessionUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
}

export type LoginError = "invalid_credentials" | "locked" | "inactive" | "rate_limited";

export type LoginResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: LoginError };

export type Clock = () => Date;

const defaultClock: Clock = () => new Date();

/**
 * Pre-computed argon2id hash of a random secret (never a real password).
 * Verifying this for unknown usernames costs the same as a real verify.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$M0NYb25lUGFzc3dvcmRTYWx0$VYcNdxvJMklbCb8UfHFbODsI2s0DlC6PZHXOJyZbeBA";

/**
 * Verify credentials and apply the brute-force lockout policy.
 *
 * - Unknown user → dummy verify, then `invalid_credentials`.
 * - Locked (locked_until in the future) → `locked` before any verify.
 * - Inactive → `inactive`, never counted as a credential failure.
 * - Wrong password → failed_attempts++; at MAX_FAILED_ATTEMPTS sets
 *   locked_until = now + LOCKOUT_MS.
 * - Success → resets failed_attempts/locked_until.
 *
 * `now` is injectable so tests can simulate lockout windows.
 */
export async function login(
  db: Database,
  username: string,
  password: string,
  now: Clock = defaultClock,
): Promise<LoginResult> {
  // Usernames are stored lowercase; normalize so 'Andres' matches 'andres'.
  const normalized = username.trim().toLowerCase();
  let [user] = await db.select().from(users).where(eq(users.username, normalized));

  if (!user) {
    await verify(DUMMY_HASH, password);
    return { ok: false, error: "invalid_credentials" };
  }

  const nowDate = now();
  if (user.lockedUntil) {
    if (user.lockedUntil > nowDate) return { ok: false, error: "locked" };
    // Lock expired: grant a fresh set of attempts before verifying again.
    await db
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    user = { ...user, failedAttempts: 0, lockedUntil: null };
  }

  if (!user.isActive) return { ok: false, error: "inactive" };

  if (!(await verify(user.passwordHash, password))) {
    const failedAttempts = user.failedAttempts + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(nowDate.getTime() + LOCKOUT_MS)
        : null;
    await db.update(users).set({ failedAttempts, lockedUntil }).where(eq(users.id, user.id));
    return { ok: false, error: "invalid_credentials" };
  }

  await db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(users.id, user.id));
  return {
    ok: true,
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
  };
}

/**
 * Client-bucket sentinel for requests whose IP cannot be determined (no
 * trusted proxy header). Sharing one bucket is intentionally conservative.
 */
export const UNKNOWN_IP = "unknown";

/** Extract the client IP from a headers map (as `next/headers` provides it). */
export function ipFromHeaders(headers: Headers): string {
  // Vercel (and standard proxies) put the client first in x-forwarded-for.
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || UNKNOWN_IP;
}

/**
 * Login entry point with the per-IP brute-force guard composed with the
 * per-account lockout. The IP gate runs BEFORE any account lookup so a
 * flooded IP cannot even probe usernames; `rate_limited` reveals nothing
 * about account existence and skips argon2 work (same early-exit shape as
 * the `locked` path). Every failed attempt — invalid credentials, locked or
 * inactive — counts against the IP, then opportunistically prunes rows older
 * than IP_ATTEMPT_RETENTION_MS so the table stays small without a cron.
 */
export async function loginWithIpGuard(
  db: Database,
  ip: string,
  username: string,
  password: string,
  now: Clock = defaultClock,
): Promise<LoginResult> {
  const windowStart = new Date(now().getTime() - IP_WINDOW_MS);
  const [attempts] = await db
    .select({ attempts: count() })
    .from(loginIpAttempts)
    .where(and(eq(loginIpAttempts.ip, ip), gt(loginIpAttempts.attemptedAt, windowStart)));

  if (attempts.attempts >= MAX_IP_ATTEMPTS) {
    return { ok: false, error: "rate_limited" };
  }

  const result = await login(db, username, password, now);
  if (!result.ok) {
    await db.insert(loginIpAttempts).values({ ip, attemptedAt: now() });
    await db
      .delete(loginIpAttempts)
      .where(lt(loginIpAttempts.attemptedAt, new Date(now().getTime() - IP_ATTEMPT_RETENTION_MS)));
  }
  return result;
}

/** 32 random bytes, URL-safe. 256 bits of entropy; sent to the client verbatim. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions store only this; the raw token lives only in the user's cookie. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Create a DB session row for `userId`; returns the raw token for the cookie. */
export async function createSession(
  db: Database,
  userId: string,
  now: Clock = defaultClock,
): Promise<{ token: string; expiresAt: Date }> {
  // Housekeeping: purge this user's expired sessions so the table stays small.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, now())));
  const token = generateSessionToken();
  const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt });
  return { token, expiresAt };
}

export interface SessionInfo {
  user: SessionUser;
  /** (Possibly renewed) expiry — callers may refresh the cookie maxAge with it. */
  expiresAt: Date;
  /** True when sliding renewal extended the DB expiry during this call. */
  renewed: boolean;
}

/**
 * Validate a session token against the DB.
 *
 * Rejects expired sessions and sessions of deactivated users. Sliding
 * renewal: when less than half the TTL remains, extends expires_at so
 * active users are not logged out mid-use.
 */
export async function getSessionUser(
  db: Database,
  token: string,
  now: Clock = defaultClock,
): Promise<SessionInfo | null> {
  const tokenHash = hashToken(token);
  const nowDate = now();

  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, nowDate),
        eq(users.isActive, true),
      ),
    );

  if (!row) return null;

  const user: SessionUser = { id: row.id, username: row.username, name: row.name, role: row.role };
  const remaining = row.expiresAt.getTime() - nowDate.getTime();
  if (remaining >= SESSION_TTL_MS / 2) {
    return { user, expiresAt: row.expiresAt, renewed: false };
  }

  const expiresAt = new Date(nowDate.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.sessionId));
  return { user, expiresAt, renewed: true };
}

/** Delete the session row; the caller clears the cookie. */
export async function destroySession(
  db: Database,
  token: string,
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/**
 * Revoke every session of a user — run after credential rotation so a stolen
 * session cannot outlive a password change/reset (sessions carry no password
 * binding). `exceptTokenHash` keeps the caller's current session alive on the
 * self-service path; the admin reset path omits it to kill them all.
 */
export async function revokeUserSessions(
  // Accepts the pooled client or a transaction handle (structural, no cast).
  db: Pick<Database, "delete">,
  userId: string,
  exceptTokenHash?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      exceptTokenHash
        ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, exceptTokenHash))
        : eq(sessions.userId, userId),
    );
}

/** Thrown by requireAdmin when the current user lacks the admin role. */
export class ForbiddenError extends Error {
  constructor() {
    super("Admin role required");
    this.name = "ForbiddenError";
  }
}

/** Guard for admin-only operations; throws ForbiddenError. */
export function requireAdmin(user: SessionUser): void {
  if (user.role !== "admin") throw new ForbiddenError();
}

/** Verify a password against a stored argon2 hash (login + self-service). */
export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/** argon2id with library defaults (m=19456, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** Set (or reset) a user's password, e.g. from the admin members screen. */
export async function setPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(eq(users.id, userId));
}
