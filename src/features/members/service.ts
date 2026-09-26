/**
 * Members administration service.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Authorization is enforced by the server actions on top of
 * this service — the service itself trusts its caller.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import type { Database } from "@/db";
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS, hashPassword, verifyPassword } from "@/lib/password";
import { revokeUserSessions } from "@/lib/sessions";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";

export interface MemberView {
  id: string;
  username: string;
  name: string;
  role: "admin" | "member";
  isActive: boolean;
}

/** Shared shape for form state surfaced through useActionState. */
export interface MemberFormState {
  ok?: boolean;
  /** Single user-facing error (admin guard, delete restrict, etc.). */
  error?: string;
  /** Per-field validation errors, keyed by input name. */
  fieldErrors?: Record<string, string>;
}

export const createMemberSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Mínimo 3 caracteres")
    .max(32)
    .regex(/^[a-z0-9_.-]+$/, "Solo letras, números, punto, guion y guion bajo"),
  name: z.string().trim().min(1, "El nombre es obligatorio").max(80),
  password: z.string().min(8, "Mínimo 8 caracteres").max(128),
  role: z.enum(["admin", "member"]),
});

export const updateMemberSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(80),
  role: z.enum(["admin", "member"]),
  isActive: z.boolean(),
  /** Empty string = keep current password; otherwise reset it. */
  newPassword: z.union([z.string().min(8, "Mínimo 8 caracteres").max(128), z.literal("")]),
});

export type CreateMemberInput = z.output<typeof createMemberSchema>;
export type UpdateMemberInput = z.output<typeof updateMemberSchema>;

export async function listMembers(db: Database): Promise<MemberView[]> {
  return db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .orderBy(asc(users.username));
}

export type MemberMutationError = "username_taken" | "member_not_found" | "has_movements";

export async function createMember(
  db: Database,
  input: CreateMemberInput,
): Promise<{ ok: true; member: MemberView } | { ok: false; error: MemberMutationError }> {
  const passwordHash = await hashPassword(input.password);
  try {
    const [member] = await db
      .insert(users)
      .values({
        username: input.username,
        name: input.name,
        role: input.role,
        passwordHash,
      })
      .returning({
        id: users.id,
        username: users.username,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
      });
    return { ok: true, member };
  } catch (error) {
    if (hasPgError(error, "23505")) return { ok: false, error: "username_taken" };
    throw error;
  }
}

export async function updateMember(
  db: Database,
  id: string,
  input: UpdateMemberInput,
): Promise<{ ok: true } | { ok: false; error: MemberMutationError }> {
  const passwordHash = input.newPassword ? await hashPassword(input.newPassword) : undefined;
  const updated = await db
    .update(users)
    .set({
      name: input.name,
      role: input.role,
      isActive: input.isActive,
      // A password reset also clears any lockout state.
      ...(input.newPassword ? { passwordHash, failedAttempts: 0, lockedUntil: null } : {}),
    })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (updated.length === 0) return { ok: false, error: "member_not_found" };
  // A password reset kills ALL of the member's sessions: none is "current"
  // from the admin's perspective, so every stolen token dies with the hash.
  if (input.newPassword) await revokeUserSessions(db, id);
  return { ok: true };
}

export async function deleteMember(
  db: Database,
  id: string,
): Promise<{ ok: true } | { ok: false; error: MemberMutationError }> {
  try {
    const deleted = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (deleted.length === 0) return { ok: false, error: "member_not_found" };
    return { ok: true };
  } catch (error) {
    // RESTRICT FKs (movements, savings/loan ledgers) → 23001 on PGlite, 23503 on PG 17.
    if (hasPgFkError(error)) return { ok: false, error: "has_movements" };
    throw error;
  }
}

/**
 * Self-service profile (Perfil page): the acting user may change their own
 * password and rename themselves. Authorization lives in the server actions
 * (requireUser); the service enforces the credential and policy checks.
 */

/** Same password policy as member create/edit (min 8, max 128). */
export const ownPasswordSchema = z.object({
  currentPassword: z.string().min(1, "Ingresá la contraseña actual"),
  newPassword: createMemberSchema.shape.password,
});

/** Same name policy as the admin member edit form. */
export const ownNameSchema = updateMemberSchema.pick({ name: true });

export type OwnPasswordError =
  | "wrong_current_password"
  | "locked"
  | "invalid_password"
  | "member_not_found";

/**
 * Change the caller's own password: the current one is verified with the
 * same argon2 path as login, then the new one is hashed via hashPassword.
 *
 * The current-password check shares the login lockout machinery (users
 * table): wrong guesses count toward failed_attempts and lock the account
 * at MAX_FAILED_ATTEMPTS, so a stolen session cannot brute-force the old
 * password outside login's protections. On success the password update and
 * the revocation of every OTHER session commit in one transaction — the
 * caller's own session survives via `exceptTokenHash` (SHA-256 of the raw
 * cookie token).
 */
export async function changeOwnPassword(
  db: Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
  exceptTokenHash?: string,
): Promise<{ ok: true } | { ok: false; error: OwnPasswordError }> {
  if (!ownPasswordSchema.shape.newPassword.safeParse(newPassword).success) {
    return { ok: false, error: "invalid_password" };
  }

  let [user] = await db
    .select({
      passwordHash: users.passwordHash,
      failedAttempts: users.failedAttempts,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { ok: false, error: "member_not_found" };

  const nowDate = new Date();
  if (user.lockedUntil) {
    // Same rule as login: while locked, credentials are never verified —
    // not even the correct one.
    if (user.lockedUntil > nowDate) return { ok: false, error: "locked" };
    // Lock expired: grant a fresh set of attempts before verifying again.
    await db
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    user = { ...user, failedAttempts: 0, lockedUntil: null };
  }

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    // Same lock rule as login: at MAX_FAILED_ATTEMPTS, lock the account.
    const failedAttempts = user.failedAttempts + 1;
    const lockedUntil =
      failedAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(nowDate.getTime() + LOCKOUT_MS)
        : null;
    await db.update(users).set({ failedAttempts, lockedUntil }).where(eq(users.id, userId));
    return { ok: false, error: "wrong_current_password" };
  }

  // A password change clears any lockout state (same as admin reset) and
  // revokes every OTHER session so a stolen one cannot survive the rotation.
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    await revokeUserSessions(tx, userId, exceptTokenHash);
  });
  return { ok: true };
}

/** Rename the caller's own display name. */
export async function updateOwnName(
  db: Database,
  userId: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: "member_not_found" }> {
  const updated = await db
    .update(users)
    .set({ name })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (updated.length === 0) return { ok: false, error: "member_not_found" };
  return { ok: true };
}
