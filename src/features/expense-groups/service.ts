/**
 * Expense groups service.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Creating is open to any authenticated member; update,
 * status changes and delete require an admin (enforced here, service level).
 * Deleting a group is ALWAYS allowed: transactions.group_id is FK SET NULL,
 * so movements survive without a group.
 */
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { expenseGroups, transactions } from "@/db/schema";
import type { Database } from "@/db";
import type { SessionUser } from "@/lib/auth";

export interface ExpenseGroupView {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "closed";
  transactionCount: number;
}

export const expenseGroupSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(80, "Máximo 80 caracteres"),
  description: z.union([z.string().trim().max(280, "Máximo 280 caracteres"), z.literal("")]),
});

export type ExpenseGroupInput = z.output<typeof expenseGroupSchema>;

export type ExpenseGroupMutationError = "group_not_found" | "forbidden";

export type ExpenseGroupResult =
  | { ok: true }
  | { ok: false; error: ExpenseGroupMutationError };

export async function listExpenseGroups(db: Database): Promise<ExpenseGroupView[]> {
  return db
    .select({
      id: expenseGroups.id,
      name: expenseGroups.name,
      description: expenseGroups.description,
      status: expenseGroups.status,
      transactionCount: count(transactions.id),
    })
    .from(expenseGroups)
    .leftJoin(
      transactions,
      and(
        eq(transactions.groupId, expenseGroups.id),
        // Pending quick-capture rows never carry a group, but keep the
        // count honest if that ever changes.
        eq(transactions.needsDetails, false),
      ),
    )
    .groupBy(expenseGroups.id)
    .orderBy(asc(expenseGroups.name));
}

export async function createExpenseGroup(
  db: Database,
  input: ExpenseGroupInput,
): Promise<ExpenseGroupResult> {
  await db.insert(expenseGroups).values({
    name: input.name,
    description: input.description ? input.description : null,
  });
  return { ok: true };
}

export async function updateExpenseGroup(
  db: Database,
  user: SessionUser,
  id: string,
  input: ExpenseGroupInput,
): Promise<ExpenseGroupResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(expenseGroups)
    .set({
      name: input.name,
      description: input.description ? input.description : null,
    })
    .where(eq(expenseGroups.id, id))
    .returning({ id: expenseGroups.id });
  if (updated.length === 0) return { ok: false, error: "group_not_found" };
  return { ok: true };
}

export async function setExpenseGroupStatus(
  db: Database,
  user: SessionUser,
  id: string,
  status: "active" | "closed",
): Promise<ExpenseGroupResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(expenseGroups)
    .set({ status })
    .where(eq(expenseGroups.id, id))
    .returning({ id: expenseGroups.id });
  if (updated.length === 0) return { ok: false, error: "group_not_found" };
  return { ok: true };
}

/** FK SET NULL: deletion always succeeds; movements keep living groupless. */
export async function removeExpenseGroup(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<ExpenseGroupResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const deleted = await db
    .delete(expenseGroups)
    .where(eq(expenseGroups.id, id))
    .returning({ id: expenseGroups.id });
  if (deleted.length === 0) return { ok: false, error: "group_not_found" };
  return { ok: true };
}
