/**
 * Categories service.
 *
 * Pure-ish functions over the DB (no Next.js imports) so they are testable
 * against PGlite. Authorization is enforced HERE, not just in the UI:
 * creating is open to any authenticated member (fluid expense entry needs
 * it), while edit/toggle/delete require an admin and take the calling
 * SessionUser to verify the role. Deactivation (toggle) is the alternative
 * to delete when movements reference a category — inactive categories stay
 * visible here but are filtered out of transaction forms by their callers.
 */
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { budgets, categories } from "@/db/schema";
import type { Database } from "@/db";
import { hasPgError, hasPgFkError } from "@/db/pg-errors";
import type { SessionUser } from "@/lib/auth";

export interface CategoryView {
  id: string;
  name: string;
  kind: "income" | "expense";
  color: string;
  icon: string | null;
  isActive: boolean;
}

export const categorySchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(64, "Máximo 64 caracteres"),
  kind: z.enum(["income", "expense"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "El color debe tener formato #RRGGBB"),
  /** Optional short emoji/text tag; empty string is normalized to null. */
  icon: z.union([z.string().trim().max(16, "Máximo 16 caracteres"), z.literal("")]),
});

export type CategoryInput = z.output<typeof categorySchema>;

export type CategoryMutationError =
  | "name_taken"
  | "category_not_found"
  | "has_movements"
  | "forbidden";

export type CategoryResult =
  | { ok: true }
  | { ok: false; error: CategoryMutationError };

export async function listCategories(
  db: Database,
  kind?: "income" | "expense",
): Promise<CategoryView[]> {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      kind: categories.kind,
      color: categories.color,
      icon: categories.icon,
      isActive: categories.isActive,
    })
    .from(categories)
    .where(kind ? eq(categories.kind, kind) : undefined)
    // Grouped view order: kind, then active first, then alphabetical.
    .orderBy(asc(categories.kind), desc(categories.isActive), asc(categories.name));
}

export async function createCategory(
  db: Database,
  input: CategoryInput,
): Promise<CategoryResult> {
  try {
    await db.insert(categories).values({
      name: input.name,
      kind: input.kind,
      color: input.color,
      icon: input.icon ? input.icon : null,
    });
    return { ok: true };
  } catch (error) {
    // categories.name is UNIQUE.
    if (hasPgError(error, "23505")) return { ok: false, error: "name_taken" };
    throw error;
  }
}

export async function updateCategory(
  db: Database,
  user: SessionUser,
  id: string,
  input: CategoryInput,
): Promise<CategoryResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    const updated = await db
      .update(categories)
      .set({
        name: input.name,
        kind: input.kind,
        color: input.color,
        icon: input.icon ? input.icon : null,
      })
      .where(eq(categories.id, id))
      .returning({ id: categories.id });
    if (updated.length === 0) return { ok: false, error: "category_not_found" };
    return { ok: true };
  } catch (error) {
    if (hasPgError(error, "23505")) return { ok: false, error: "name_taken" };
    throw error;
  }
}

/** Soft-delete path: flips is_active; the row stays visible for history. */
export async function toggleCategoryActive(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<CategoryResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  const updated = await db
    .update(categories)
    .set({ isActive: sql`not ${categories.isActive}` })
    .where(eq(categories.id, id))
    .returning({ id: categories.id });
  if (updated.length === 0) return { ok: false, error: "category_not_found" };
  return { ok: true };
}

export async function removeCategory(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<CategoryResult> {
  if (user.role !== "admin") return { ok: false, error: "forbidden" };
  try {
    // Budgets are plan config, not accounting history: cascade-delete them in
    // the same transaction. Transactions still RESTRICT the delete (R4) and
    // surface as the typed 'has_movements' error.
    const deleted = await db.transaction(async (tx) => {
      await tx.delete(budgets).where(eq(budgets.categoryId, id));
      return tx
        .delete(categories)
        .where(eq(categories.id, id))
        .returning({ id: categories.id });
    });
    if (deleted.length === 0) return { ok: false, error: "category_not_found" };
    return { ok: true };
  } catch (error) {
    // RESTRICT FK: transactions.category_id (budgets rows are cascaded above).
    if (hasPgFkError(error)) return { ok: false, error: "has_movements" };
    throw error;
  }
}
