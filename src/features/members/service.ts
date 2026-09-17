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
import { hashPassword } from "@/lib/auth";

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
    if (hasPgCode(error, "23505")) return { ok: false, error: "username_taken" };
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
    // RESTRICT FKs (movements, envelopes) → Postgres restrict_violation.
    if (hasPgCode(error, "23001")) return { ok: false, error: "has_movements" };
    throw error;
  }
}

/** Match a Postgres error code on the error or its cause (drizzle wraps). */
function hasPgCode(error: unknown, code: string): boolean {
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === code || err.cause?.code === code;
}
