"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { categories } from "@/db/schema";
import { requireUser } from "@/features/auth/session";
import {
  categorySchema,
  createCategory,
} from "@/features/categories/service";
import {
  createTransaction,
  movementSchema,
  removeTransaction,
  updateTransaction,
} from "@/features/transactions/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";

/** FormState plus the category created inline from the movement form. */
export interface InlineCategoryState extends FormState {
  categoryId?: string;
  categoryName?: string;
}

function readMovementForm(formData: FormData) {
  return {
    date: formData.get("date") ?? "",
    amount: formData.get("amount"),
    type: formData.get("type"),
    categoryId: formData.get("categoryId") ?? "",
    memberId: formData.get("memberId") ?? "",
    envelopeId: formData.get("envelopeId") ?? "",
    groupId: formData.get("groupId") ?? "",
    scope: formData.get("scope") ?? "common",
    note: formData.get("note") ?? "",
  };
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapMovementError(error: string): FormState {
  if (error === "invalid_amount") {
    return { fieldErrors: { amount: "El monto no es válido." } };
  }
  if (error === "category_kind_mismatch") {
    return {
      fieldErrors: { categoryId: "La categoría no corresponde al tipo de movimiento." },
    };
  }
  if (error === "envelope_member_mismatch") {
    return { fieldErrors: { envelopeId: "La bolsa no pertenece al integrante del movimiento." } };
  }
  if (error === "envelope_inactive") {
    return { fieldErrors: { envelopeId: "La bolsa está inactiva." } };
  }
  if (error === "group_closed") {
    return { fieldErrors: { groupId: "El grupo está cerrado." } };
  }
  if (error === "not_found") {
    return { error: "Alguno de los datos seleccionados ya no existe. Recarga e intenta de nuevo." };
  }
  if (error === "forbidden") {
    return { error: "No puedes modificar movimientos de otros integrantes." };
  }
  return { error: "No se pudo guardar el movimiento." };
}

/** Revalidate every surface that shows movements (list, filters, dashboard). */
function revalidateMovements(): void {
  revalidatePath("/movimientos");
  revalidatePath("/");
}

export async function createMovementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const parsed = movementSchema.safeParse(readMovementForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createTransaction(getDb(), user, parsed.data);
  if (!result.ok) return mapMovementError(result.error);

  revalidateMovements();
  return { ok: true };
}

export async function updateMovementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const id = idFrom(formData);
  if (!id) return { error: "Movimiento inválido." };

  const parsed = movementSchema.safeParse(readMovementForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateTransaction(getDb(), user, id, parsed.data);
  if (!result.ok) return mapMovementError(result.error);

  revalidateMovements();
  return { ok: true };
}

/**
 * /movimientos/nuevo page variant: same create rules, but bounces back to the
 * list after a successful save (works with and without client JS).
 */
export async function createMovementAndRedirectAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await createMovementAction(_prev, formData);
  if (result.ok) redirect("/movimientos");
  return result;
}

export async function deleteMovementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const id = idFrom(formData);
  if (!id) return { error: "Movimiento inválido." };

  const result = await removeTransaction(getDb(), user, id);
  if (!result.ok) {
    return result.error === "not_found"
      ? { error: "El movimiento ya no existe." }
      : mapMovementError(result.error);
  }

  revalidateMovements();
  return { ok: true };
}

/**
 * Inline "new category" from the movement form: open to any authenticated
 * member (fluid entry), kind comes from the current type toggle. Returns the
 * created id so the client can select it immediately.
 */
export async function createCategoryInlineAction(
  _prev: InlineCategoryState,
  formData: FormData,
): Promise<InlineCategoryState> {
  await requireUser();

  const parsed = categorySchema.safeParse({
    name: formData.get("categoryName"),
    kind: formData.get("kind"),
    color: formData.get("categoryColor"),
    icon: "",
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createCategory(getDb(), parsed.data);
  if (!result.ok) {
    return result.error === "name_taken"
      ? { fieldErrors: { name: "Ya existe una categoría con ese nombre." } }
      : { error: "No se pudo crear la categoría." };
  }

  // names are UNIQUE — safe lookup for the just-created row.
  const [created] = await getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.name, parsed.data.name))
    .limit(1);

  revalidateMovements();
  return { ok: true, categoryId: created?.id, categoryName: parsed.data.name };
}
