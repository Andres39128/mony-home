import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { users } from "@/db/schema";
import {
  IP_ATTEMPT_RETENTION_MS,
  IP_WINDOW_MS,
  SESSION_TTL_MS,
  UNKNOWN_IP,
  MAX_IP_ATTEMPTS,
  createSession,
  destroySession,
  getSessionUser,
  hashToken,
  ipFromHeaders,
  login,
  loginWithIpGuard,
  requireAdmin,
  setPassword,
  ForbiddenError,
} from "@/lib/auth";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS, hashPassword } from "@/lib/password";
import { loginIpAttempts, sessions } from "@/db/schema";

/**
 * Auth integration suite: login policy (lockout, inactive, uniform unknown
 * user) and session lifecycle, against in-memory Postgres with the real
 * migrations and an injected clock. Each test gets a fresh database — login
 * mutates shared user state, so isolation keeps tests order-independent.
 */
describe("auth (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite | undefined;

  /** Mutable clock for simulating the passage of time. */
  let now: Date;
  const clock = (): Date => now;

  const createTestUser = async (overrides: Partial<typeof users.$inferInsert> = {}) => {
    const [user] = await db
      .insert(users)
      .values({
        username: "andres",
        passwordHash: await hashPassword("correct-horse-1"),
        name: "Andrés",
        ...overrides,
      })
      .returning();
    return user;
  };

  beforeEach(async () => {
    await client?.close();
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    now = new Date("2026-09-17T12:00:00.000Z");
  });

  afterAll(async () => {
    // PGlite holds a wasm instance; close it so vitest exits cleanly.
    await client?.close();
  });

  describe("login", () => {
    it("succeeds with valid credentials and resets failure state", async () => {
      const user = await createTestUser({ failedAttempts: 3, lockedUntil: null });
      // Pre-seed a stale failure count to prove success resets it.
      await db
        .update(users)
        .set({ failedAttempts: 2 })
        .where(eq(users.id, user.id));

      const result = await login(appDb, "andres", "correct-horse-1", clock);

      expect(result).toEqual({
        ok: true,
        user: { id: user.id, username: "andres", name: "Andrés", role: "member" },
      });
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.failedAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });

    it("is case-insensitive on username", async () => {
      await createTestUser();
      const result = await login(appDb, "  Andres ", "correct-horse-1", clock);
      expect(result.ok).toBe(true);
    });

    it("rejects a wrong password and increments failed_attempts", async () => {
      const user = await createTestUser();

      const result = await login(appDb, "andres", "wrong-password", clock);

      expect(result).toEqual({ ok: false, error: "invalid_credentials" });
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.failedAttempts).toBe(1);
    });

    it("rejects an unknown user identically to a wrong password", async () => {
      const knownResult = await login(appDb, "ghost", "whatever-password", clock);
      await createTestUser();
      const unknownResult = await login(appDb, "andres-unknown", "whatever-password", clock);

      expect(unknownResult).toEqual(knownResult);
      expect(unknownResult).toEqual({ ok: false, error: "invalid_credentials" });
    });

    it("locks the account after MAX_FAILED_ATTEMPTS and rejects even the correct password", async () => {
      const user = await createTestUser();

      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await login(appDb, "andres", "wrong-password", clock);
      }
      const lockedResult = await login(appDb, "andres", "correct-horse-1", clock);

      expect(lockedResult).toEqual({ ok: false, error: "locked" });
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.lockedUntil).not.toBeNull();
      // Lockout window: now + LOCKOUT_MS.
      expect(row.lockedUntil!.getTime()).toBe(now.getTime() + LOCKOUT_MS);
    });

    it("rejects a locked account before verifying credentials", async () => {
      await createTestUser({
        failedAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
      });

      const result = await login(appDb, "andres", "correct-horse-1", clock);

      expect(result).toEqual({ ok: false, error: "locked" });
    });

    it("grants a fresh attempt counter once the lockout window has passed", async () => {
      const user = await createTestUser({
        failedAttempts: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
      });

      // Advance past the (tiny in real use; injected here) window.
      now = new Date(now.getTime() + LOCKOUT_MS + 1);
      const result = await login(appDb, "andres", "correct-horse-1", clock);

      expect(result.ok).toBe(true);
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.failedAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });

    it("returns 'inactive' without counting a credential failure", async () => {
      const user = await createTestUser({ isActive: false });

      const result = await login(appDb, "andres", "totally-wrong", clock);

      expect(result).toEqual({ ok: false, error: "inactive" });
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row.failedAttempts).toBe(0);
    });
  });

  describe("per-IP rate limiting", () => {
    const IP = "203.0.113.7";

    /** Count the failed-login rows recorded for an IP. */
    const attemptCount = async (ip: string = IP) => {
      const rows = await db.select().from(loginIpAttempts).where(eq(loginIpAttempts.ip, ip));
      return rows.length;
    };

    it("blocks an IP once MAX_IP_ATTEMPTS failures are recorded — even with valid credentials", async () => {
      await createTestUser();

      for (let i = 0; i < MAX_IP_ATTEMPTS; i++) {
        const result = await loginWithIpGuard(appDb, IP, "andres", "wrong-password", clock);
        // After MAX_FAILED_ATTEMPTS the account also locks; both count here.
        expect(result.ok).toBe(false);
      }
      expect(await attemptCount()).toBe(MAX_IP_ATTEMPTS);

      // The gate runs BEFORE the account lookup: correct password is rejected
      // with rate_limited even though the lockout would say "locked".
      const blocked = await loginWithIpGuard(appDb, IP, "andres", "correct-horse-1", clock);
      expect(blocked).toEqual({ ok: false, error: "rate_limited" });
      expect(await attemptCount()).toBe(MAX_IP_ATTEMPTS);
    });

    it("does not count successful logins against the IP", async () => {
      await createTestUser();

      for (let i = 0; i < MAX_IP_ATTEMPTS; i++) {
        const result = await loginWithIpGuard(appDb, IP, "andres", "correct-horse-1", clock);
        expect(result.ok).toBe(true);
      }

      const result = await loginWithIpGuard(appDb, IP, "andres", "wrong-password", clock);
      expect(result).toEqual({ ok: false, error: "invalid_credentials" });
    });

    it("counts locked and inactive failures toward the IP too", async () => {
      await createTestUser({ isActive: false });

      expect(await loginWithIpGuard(appDb, IP, "andres", "whatever", clock)).toEqual({
        ok: false,
        error: "inactive",
      });
      expect(await attemptCount()).toBe(1);
    });

    it("reopens the IP once the window has passed (injected clock)", async () => {
      await createTestUser();

      for (let i = 0; i < MAX_IP_ATTEMPTS; i++) {
        await loginWithIpGuard(appDb, IP, "andres", "wrong-password", clock);
      }
      now = new Date(now.getTime() + IP_WINDOW_MS + 1);

      const result = await loginWithIpGuard(appDb, IP, "andres", "correct-horse-1", clock);
      expect(result.ok).toBe(true);
    });

    it("prunes rows older than the retention window after a failed attempt", async () => {
      await createTestUser();
      const stale = new Date(now.getTime() - IP_ATTEMPT_RETENTION_MS - 1);
      await db.insert(loginIpAttempts).values({ ip: IP, attemptedAt: stale });

      await loginWithIpGuard(appDb, IP, "andres", "wrong-password", clock);

      const rows = await db.select().from(loginIpAttempts);
      expect(rows).toHaveLength(1);
      expect(rows[0].attemptedAt.getTime()).toBe(now.getTime());
    });

    it("keeps IPs isolated from each other", async () => {
      await createTestUser();
      for (let i = 0; i < MAX_IP_ATTEMPTS; i++) {
        await loginWithIpGuard(appDb, "198.51.100.1", "andres", "wrong-password", clock);
      }
      // The failed attempts also locked the ACCOUNT; expire the lockout so
      // only the IP gate differentiates the two clients below.
      now = new Date(now.getTime() + LOCKOUT_MS + 1);

      const fromBlockedIp = await loginWithIpGuard(
        appDb,
        "198.51.100.1",
        "andres",
        "correct-horse-1",
        clock,
      );
      expect(fromBlockedIp).toEqual({ ok: false, error: "rate_limited" });
      const fromCleanIp = await loginWithIpGuard(appDb, IP, "andres", "correct-horse-1", clock);
      expect(fromCleanIp.ok).toBe(true);
    });

    it("ipFromHeaders takes the first forwarded value and falls back to the shared bucket", () => {
      expect(
        ipFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
      ).toBe("203.0.113.9");
      expect(ipFromHeaders(new Headers())).toBe(UNKNOWN_IP);
      expect(ipFromHeaders(new Headers({ "x-forwarded-for": "  " }))).toBe(UNKNOWN_IP);
    });
  });

  describe("sessions", () => {
    it("round-trips create → validate with the raw token only in the cookie", async () => {
      const user = await createTestUser();

      const { token, expiresAt } = await createSession(appDb, user.id, clock);
      const [row] = await db.select().from(sessions);

      expect(expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
      // The DB stores the SHA-256 of the token, never the raw value.
      expect(row.tokenHash).toBe(hashToken(token));
      expect(row.tokenHash).not.toBe(token);

      const info = await getSessionUser(appDb, token, clock);
      expect(info?.user.username).toBe("andres");
      expect(info?.renewed).toBe(false);
    });

    it("returns null for an expired session", async () => {
      const user = await createTestUser();
      const { token } = await createSession(appDb, user.id, clock);

      now = new Date(now.getTime() + SESSION_TTL_MS + 1);
      expect(await getSessionUser(appDb, token, clock)).toBeNull();
    });

    it("renews (slides) the session when less than half the TTL remains", async () => {
      const user = await createTestUser();
      const { token } = await createSession(appDb, user.id, clock);

      now = new Date(now.getTime() + (SESSION_TTL_MS / 4) * 3); // 25% left
      const info = await getSessionUser(appDb, token, clock);

      expect(info?.renewed).toBe(true);
      expect(info?.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
      const [row] = await db.select().from(sessions);
      expect(row.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
    });

    it("returns null for a session of a deactivated user", async () => {
      const user = await createTestUser();
      const { token } = await createSession(appDb, user.id, clock);

      await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));

      expect(await getSessionUser(appDb, token, clock)).toBeNull();
    });

    it("revokes the user's prior sessions on a successful login", async () => {
      const user = await createTestUser();
      const prior = await createSession(appDb, user.id, clock);
      expect((await getSessionUser(appDb, prior.token, clock))?.user.username).toBe("andres");

      const result = await login(appDb, "andres", "correct-horse-1", clock);
      expect(result.ok).toBe(true);

      // Pre-login token is dead after re-authenticating...
      expect(await getSessionUser(appDb, prior.token, clock)).toBeNull();

      // ...while the session issued after login keeps working.
      const fresh = await createSession(appDb, user.id, clock);
      expect((await getSessionUser(appDb, fresh.token, clock))?.user.id).toBe(user.id);
    });

    it("destroySession invalidates the token", async () => {
      const user = await createTestUser();
      const { token } = await createSession(appDb, user.id, clock);
      expect((await getSessionUser(appDb, token, clock))?.user.username).toBe("andres");

      await destroySession(appDb, token);

      expect(await getSessionUser(appDb, token, clock)).toBeNull();
    });

    it("purges the user's expired sessions when creating a new one", async () => {
      const user = await createTestUser();
      const stale = await createSession(appDb, user.id, clock);
      await db
        .update(sessions)
        .set({ expiresAt: new Date(now.getTime() - 1000) })
        .where(eq(sessions.tokenHash, hashToken(stale.token)));

      await createSession(appDb, user.id, clock);

      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(1);
    });

    it("cascades session deletion when the user is deleted", async () => {
      const user = await createTestUser();
      await createSession(appDb, user.id, clock);

      await db.delete(users).where(eq(users.id, user.id));

      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe("password helpers and admin guard", () => {
    it("setPassword replaces the hash so the new password logs in", async () => {
      const user = await createTestUser();

      await setPassword(appDb, user.id, "brand-new-pass-9");

      expect((await login(appDb, "andres", "brand-new-pass-9", clock)).ok).toBe(true);
      expect((await login(appDb, "andres", "correct-horse-1", clock)).ok).toBe(false);
    });

    it("requireAdmin throws ForbiddenError only for non-admins", () => {
      expect(() =>
        requireAdmin({ id: "u", username: "a", name: "A", role: "member" }),
      ).toThrow(ForbiddenError);
      expect(() =>
        requireAdmin({ id: "u", username: "a", name: "A", role: "admin" }),
      ).not.toThrow();
    });
  });
});
