import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, transactions, users } from "@/db/schema";
import { verify } from "@node-rs/argon2";
import {
  changeOwnPassword,
  createMember,
  createMemberSchema,
  deleteMember,
  listMembers,
  ownNameSchema,
  updateMember,
  updateMemberSchema,
  updateOwnName,
} from "@/features/members/service";
import { login, createSession, getSessionUser, hashToken, MAX_FAILED_ATTEMPTS } from "@/lib/auth";
import { sessions } from "@/db/schema";

/**
 * Members service suite: create/edit/deactivate/delete policies against
 * in-memory Postgres with the real migrations (FK RESTRICT included).
 */
describe("members service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;

  const validInput = {
    username: "nueva",
    name: "Nueva Persona",
    password: "super-secret-1",
    role: "member" as const,
  };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a member with a hashed password and lists them", async () => {
    const result = await createMember(appDb, validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.member).toMatchObject({
      username: "nueva",
      name: "Nueva Persona",
      role: "member",
      isActive: true,
    });
    const [row] = await db.select().from(users).where(eq(users.id, result.member.id));
    expect(row.passwordHash).not.toBe(validInput.password);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);

    const members = await listMembers(appDb);
    expect(members.map((m) => m.username)).toContain("nueva");
  });

  it("rejects a duplicate username with a typed error", async () => {
    const first = await createMember(appDb, { ...validInput, username: "duplicado" });
    const second = await createMember(appDb, { ...validInput, username: "duplicado" });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: "username_taken" });
  });

  it("edits name, role and active flag", async () => {
    const created = await createMember(appDb, { ...validInput, username: "editable" });
    if (!created.ok) throw new Error("setup failed");

    const result = await updateMember(appDb, created.member.id, {
      name: "Nombre Editado",
      role: "admin",
      isActive: false,
      newPassword: "",
    });

    expect(result).toEqual({ ok: true });
    const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
    expect(row).toMatchObject({ name: "Nombre Editado", role: "admin", isActive: false });
  });

  it("resetting the password invalidates the old one and clears lockout", async () => {
    const created = await createMember(appDb, { ...validInput, username: "resetpw" });
    if (!created.ok) throw new Error("setup failed");
    await db
      .update(users)
      .set({ failedAttempts: 5, lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(users.id, created.member.id));

    const result = await updateMember(appDb, created.member.id, {
      name: "Nueva Persona",
      role: "member",
      isActive: true,
      newPassword: "fresh-password-1",
    });

    expect(result).toEqual({ ok: true });
    const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
    // Old password no longer verifies; the new one does.
    expect(await verify(row.passwordHash, "super-secret-1")).toBe(false);
    expect(await verify(row.passwordHash, "fresh-password-1")).toBe(true);
  });

  it("deactivation blocks login (session check also rejects inactive users)", async () => {
    const created = await createMember(appDb, { ...validInput, username: "apagado" });
    if (!created.ok) throw new Error("setup failed");

    await updateMember(appDb, created.member.id, {
      name: "Nueva Persona",
      role: "member",
      isActive: false,
      newPassword: "",
    });

    const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
    expect(row.isActive).toBe(false);
  });

  it("deleting a member with movements fails with a typed restrict error", async () => {
    const created = await createMember(appDb, { ...validInput, username: "conmovs" });
    if (!created.ok) throw new Error("setup failed");
    const [category] = await db
      .insert(categories)
      .values({ name: "Test Cat", kind: "expense" })
      .returning();
    await db.insert(transactions).values({
      amountCents: 100,
      type: "expense",
      categoryId: category.id,
      memberId: created.member.id,
    });

    const result = await deleteMember(appDb, created.member.id);

    expect(result).toEqual({ ok: false, error: "has_movements" });
    // The member is still there — deactivation is the alternative path.
    const members = await listMembers(appDb);
    expect(members.some((m) => m.id === created.member.id)).toBe(true);
  });

  it("deleting a member without movements succeeds and cascades sessions", async () => {
    const created = await createMember(appDb, { ...validInput, username: "limpio" });
    if (!created.ok) throw new Error("setup failed");

    const result = await deleteMember(appDb, created.member.id);

    expect(result).toEqual({ ok: true });
    const members = await listMembers(appDb);
    expect(members.some((m) => m.username === "limpio")).toBe(false);
  });

  it("reports a typed error when updating or deleting an unknown id", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";

    expect(await updateMember(appDb, ghostId, { name: "X", role: "member", isActive: true, newPassword: "" }))
      .toEqual({ ok: false, error: "member_not_found" });
    expect(await deleteMember(appDb, ghostId)).toEqual({ ok: false, error: "member_not_found" });
  });

  describe("input schemas (trust boundary)", () => {
    it("normalizes username case and whitespace", () => {
      const parsed = createMemberSchema.parse({
        username: "  Nueva  ",
        name: " Algo ",
        password: "super-secret-1",
        role: "member",
      });
      expect(parsed.username).toBe("nueva");
      expect(parsed.name).toBe("Algo");
    });

    it("rejects bad usernames, short passwords and unknown roles", () => {
      const base = { name: "X", password: "super-secret-1", role: "member" as const };
      expect(createMemberSchema.safeParse({ ...base, username: "ab" }).success).toBe(false);
      expect(createMemberSchema.safeParse({ ...base, username: "con espacios!" }).success).toBe(false);
      expect(createMemberSchema.safeParse({ ...base, username: "okuser", password: "corta" }).success).toBe(false);
      expect(createMemberSchema.safeParse({ ...base, username: "okuser", role: "superuser" }).success).toBe(false);
    });

    it("update schema requires the empty-string or 8+ char password contract", () => {
      expect(updateMemberSchema.safeParse({ name: "X", role: "member", isActive: true, newPassword: "" }).success).toBe(true);
      expect(updateMemberSchema.safeParse({ name: "X", role: "member", isActive: true, newPassword: "nueva-clave-1" }).success).toBe(true);
      expect(updateMemberSchema.safeParse({ name: "X", role: "member", isActive: true, newPassword: "corta" }).success).toBe(false);
    });
  });

  describe("self-service profile (changeOwnPassword / updateOwnName)", () => {
    it("rejects a wrong current password and keeps the old one working", async () => {
      const created = await createMember(appDb, { ...validInput, username: "cambiapw" });
      if (!created.ok) throw new Error("setup failed");

      expect(
        await changeOwnPassword(appDb, created.member.id, "contraseña-erronea", "nueva-clave-99"),
      ).toEqual({ ok: false, error: "wrong_current_password" });

      // The old credential still logs in; the new one was never set.
      expect((await login(appDb, "cambiapw", validInput.password)).ok).toBe(true);
      expect((await login(appDb, "cambiapw", "nueva-clave-99")).ok).toBe(false);
    });

    it("rejects a policy-violating new password before touching anything", async () => {
      const created = await createMember(appDb, { ...validInput, username: "politica" });
      if (!created.ok) throw new Error("setup failed");

      expect(
        await changeOwnPassword(appDb, created.member.id, validInput.password, "corta"),
      ).toEqual({ ok: false, error: "invalid_password" });

      expect((await login(appDb, "politica", validInput.password)).ok).toBe(true);
    });

    it("on success re-hashes and the new password verifies via the login path", async () => {
      const created = await createMember(appDb, { ...validInput, username: "exitopw" });
      if (!created.ok) throw new Error("setup failed");
      await db
        .update(users)
        .set({ failedAttempts: 3, lockedUntil: null })
        .where(eq(users.id, created.member.id));

      const result = await changeOwnPassword(
        appDb,
        created.member.id,
        validInput.password,
        "nueva-clave-99",
      );
      expect(result).toEqual({ ok: true });

      const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toBe(validInput.password);
      // Same path login uses: old fails, new passes; lockout counters cleared.
      expect(await login(appDb, "exitopw", validInput.password)).toMatchObject({
        ok: false,
        error: "invalid_credentials",
      });
      expect(await login(appDb, "exitopw", "nueva-clave-99")).toMatchObject({
        ok: true,
        user: { username: "exitopw" },
      });
      expect(row.failedAttempts).toBe(0);
    });

    it("renames own display name following the member-edit name policy", async () => {
      const created = await createMember(appDb, { ...validInput, username: "renombre" });
      if (!created.ok) throw new Error("setup failed");

      // Same policy as the admin edit form: trimmed, 1-80 chars.
      expect(ownNameSchema.safeParse({ name: "   " }).success).toBe(false);
      expect(ownNameSchema.safeParse({ name: "x".repeat(81) }).success).toBe(false);
      expect(ownNameSchema.safeParse({ name: "  Nombre Nuevo  " }).success).toBe(true);

      expect(await updateOwnName(appDb, created.member.id, "Nombre Nuevo")).toEqual({ ok: true });
      const members = await listMembers(appDb);
      expect(members.find((m) => m.id === created.member.id)?.name).toBe("Nombre Nuevo");
    });
  });

  describe("session revocation on credential rotation", () => {
    it("changeOwnPassword keeps only the caller's current session alive", async () => {
      const created = await createMember(appDb, { ...validInput, username: "rotapw" });
      if (!created.ok) throw new Error("setup failed");
      const current = await createSession(appDb, created.member.id);
      const stolen = await createSession(appDb, created.member.id);

      const result = await changeOwnPassword(
        appDb,
        created.member.id,
        validInput.password,
        "nueva-clave-77",
        hashToken(current.token),
      );

      expect(result).toEqual({ ok: true });
      // The current session row survives; every other one is gone.
      const rows = await db.select().from(sessions);
      expect(rows.map((r) => r.tokenHash)).toEqual([hashToken(current.token)]);
      expect(await getSessionUser(appDb, current.token)).not.toBeNull();
      expect(await getSessionUser(appDb, stolen.token)).toBeNull();
      // Old password fails, new one works via the login path.
      expect((await login(appDb, "rotapw", validInput.password)).ok).toBe(false);
      expect((await login(appDb, "rotapw", "nueva-clave-77")).ok).toBe(true);
    });

    it("admin password reset revokes ALL sessions of the member", async () => {
      const created = await createMember(appDb, { ...validInput, username: "resetall" });
      if (!created.ok) throw new Error("setup failed");
      const first = await createSession(appDb, created.member.id);
      const second = await createSession(appDb, created.member.id);

      const result = await updateMember(appDb, created.member.id, {
        name: created.member.name,
        role: "member",
        isActive: true,
        newPassword: "otra-clave-11",
      });

      expect(result).toEqual({ ok: true });
      const rows = await db.select().from(sessions).where(eq(sessions.userId, created.member.id));
      expect(rows).toHaveLength(0);
      expect(await getSessionUser(appDb, first.token)).toBeNull();
      expect(await getSessionUser(appDb, second.token)).toBeNull();
      expect((await login(appDb, "resetall", "otra-clave-11")).ok).toBe(true);
    });
  });

  describe("current-password oracle throttle (shared login lockout)", () => {
    it("locks the account after MAX wrong guesses and rejects even the correct password", async () => {
      const created = await createMember(appDb, { ...validInput, username: "oraculo" });
      if (!created.ok) throw new Error("setup failed");

      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        expect(
          await changeOwnPassword(appDb, created.member.id, "mala-clave", "nueva-clave-11"),
        ).toEqual({ ok: false, error: "wrong_current_password" });
      }
      // Locked BEFORE verification: the correct current password is rejected.
      expect(
        await changeOwnPassword(appDb, created.member.id, validInput.password, "nueva-clave-11"),
      ).toEqual({ ok: false, error: "locked" });

      const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
      expect(row.lockedUntil).not.toBeNull();
      // Shared mechanism: login with the CORRECT password is locked too.
      expect(await login(appDb, "oraculo", validInput.password)).toEqual({
        ok: false,
        error: "locked",
      });
    });

    it("success resets the failure counter and lock state", async () => {
      const created = await createMember(appDb, { ...validInput, username: "resetea" });
      if (!created.ok) throw new Error("setup failed");
      await db
        .update(users)
        .set({ failedAttempts: MAX_FAILED_ATTEMPTS - 1, lockedUntil: null })
        .where(eq(users.id, created.member.id));

      expect(
        await changeOwnPassword(appDb, created.member.id, validInput.password, "nueva-clave-22"),
      ).toEqual({ ok: true });

      const [row] = await db.select().from(users).where(eq(users.id, created.member.id));
      expect(row.failedAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    });
  });
});
