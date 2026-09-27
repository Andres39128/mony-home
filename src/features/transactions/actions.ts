"use server";

import { refresh } from "next/cache";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireUser } from "@/features/auth/session";
import {
  categorySchema,
  createCategory,
} from "@/features/categories/service";
import {
  createQuickTransaction,
  createTransaction,
  movementSchema,
  quickMovementSchema,
  removeTransaction,
  updateTransaction,
} from "@/features/transactions/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";
import {
  AMBIGUOUS_AMOUNT_MESSAGE,
  INVALID_AMOUNT_MESSAGE,
} from "@/lib/money-errors";

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
    groupId: formData.get("groupId") ?? "",
    scope: formData.get("scope") ?? "common",
    note: formData.get("note") ?? "",
    // Medio de pago: "card" carries cardId (validated by the service).
    paymentMethod: formData.get("paymentMethod") ?? "cash",
    cardId: formData.get("cardId") ?? "",
    // Server actions receive File entries natively via FormData.
    receipt: formData.get("receipt"),
  };
}

/** Captura rápida: the receipt is the movement; the rest stays untouched. */
function readQuickMovementForm(formData: FormData) {
  return {
    date: formData.get("date") ?? "",
    memberId: formData.get("memberId") ?? "",
    type: formData.get("type") ?? undefined,
    receipt: formData.get("receipt"),
  };
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapMovementError(error: string): FormState {
  if (error === "invalid_amount") {
    return { fieldErrors: { amount: INVALID_AMOUNT_MESSAGE } };
  }
  if (error === "ambiguous_amount") {
    return { fieldErrors: { amount: AMBIGUOUS_AMOUNT_MESSAGE } };
  }
  if (error === "category_kind_mismatch") {
    return {
      fieldErrors: { categoryId: "La categoría no corresponde al tipo de movimiento." },
    };
  }
  if (error === "member_inactive") {
    return { fieldErrors: { memberId: "El integrante seleccionado está inactivo." } };
  }
  if (error === "group_closed") {
    return { fieldErrors: { groupId: "El grupo está cerrado." } };
  }
  if (error === "receipt_too_large") {
    return { fieldErrors: { receipt: "La imagen supera el máximo de 2 MB." } };
  }
  if (error === "receipt_invalid_type") {
    return {
      fieldErrors: { receipt: "El archivo no es una imagen válida: usá JPG, PNG o WebP." },
    };
  }
  if (error === "card_not_found") {
    return { error: "La tarjeta seleccionada ya no existe. Recarga e intenta de nuevo." };
  }
  if (error === "card_inactive") {
    return { fieldErrors: { cardId: "La tarjeta está inactiva." } };
  }
  if (error === "card_not_revolving") {
    return { fieldErrors: { cardId: "El préstamo seleccionado no es una tarjeta de crédito." } };
  }
  if (error === "card_requires_expense") {
    return { fieldErrors: { cardId: "Solo los gastos pueden pagarse con tarjeta." } };
  }
  if (error === "card_limit_exceeded") {
    return {
      fieldErrors: { cardId: "La compra supera el cupo disponible de la tarjeta." },
    };
  }
  if (error === "not_found") {
    return { error: "Alguno de los datos seleccionados ya no existe. Recarga e intenta de nuevo." };
  }
  if (error === "forbidden") {
    return { error: "No puedes modificar movimientos de otros integrantes." };
  }
  return { error: "No se pudo guardar el movimiento." };
}

// NOTE: pages render dynamically (auth reads cookies() on every request),
// but Next 16 moved post-action UI updates from automatic to
// stale-while-revalidate: without an explicit refresh() the client router
// keeps serving the pre-action RSC payload until a manual navigation.
// Every mutating action therefore calls refresh() (Server-Action-only API,
// docs: upgrading/version-16#refresh) to restore read-your-writes.

export async function createMovementAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  // Captura rápida (momento de afán): only the receipt + date are read; the
  // movement files as PENDING ("Pendiente incluir detalles.").
  if (formData.get("quick") === "1") {
    const parsed = quickMovementSchema.safeParse(readQuickMovementForm(formData));
    if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

    const result = await createQuickTransaction(getDb(), user, parsed.data);
    if (!result.ok) return mapMovementError(result.error);

    refresh();

    return { ok: true };
  }

  const parsed = movementSchema.safeParse(readMovementForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createTransaction(getDb(), user, parsed.data);
  if (!result.ok) return mapMovementError(result.error);
  refresh();
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
  refresh();
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
  refresh();
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

  refresh();

  return { ok: true, categoryId: result.id, categoryName: parsed.data.name };
}
