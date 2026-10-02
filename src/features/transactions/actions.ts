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
  openingBalanceSchema,
  quickMovementSchema,
  removeTransaction,
  setOpeningBalance,
  updateTransaction,
  UUID_RE,
} from "@/features/transactions/service";
import {
  IMPORT_MAX_ROWS,
  commitImport,
  parseImportCsv,
  previewImport,
  type ImportGlobals,
  type ImportMapping,
  type ImportMutationError,
  type ImportPreview,
} from "@/features/transactions/import";
import type { ParsedCsv } from "@/features/transactions/import";
import { fieldErrorsFrom, idFrom, type FormState } from "@/lib/form-state";
import { amountFieldError } from "@/lib/money-errors";
import { ForbiddenError, requireAdmin } from "@/lib/auth";

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

function mapMovementError(error: string): FormState {
  if (error === "invalid_amount" || error === "ambiguous_amount") {
    return amountFieldError(error);
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

/** Spanish form feedback for the saldo inicial service's typed errors. */
function mapOpeningBalanceError(error: string): FormState {
  if (error === "invalid_amount" || error === "ambiguous_amount") {
    return amountFieldError(error);
  }
  if (error === "future_date") {
    return { fieldErrors: { date: "La fecha no puede ser futura." } };
  }
  if (error === "system_category_missing") {
    return {
      error: 'Falta la categoría de sistema "Saldo inicial". Ejecutá el seed y recargá.',
    };
  }
  if (error === "forbidden") {
    return { error: "Solo los administradores pueden definir el saldo inicial." };
  }
  return { error: "No se pudo guardar el saldo inicial." };
}

/**
 * Admin-only opening balance: writes/updates the ONE system adjustment that
 * anchors the app's saldo to real starting money.
 */
export async function setOpeningBalanceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const parsed = openingBalanceSchema.safeParse({
    date: formData.get("date") ?? "",
    amount: formData.get("amount"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await setOpeningBalance(getDb(), user, parsed.data);
  if (!result.ok) return mapOpeningBalanceError(result.error);
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

// ---------------------------------------------------------------------------
// CSV import wizard (F5) — one action drives the three steps: the client
// ships raw text + mapping indices only; the server parses (trust boundary).
// ---------------------------------------------------------------------------

/** Wizard state: each resolved step carries what the next one renders. */
export interface ImportState extends FormState {
  /** Step to render after the action resolves (1 = default). */
  step?: 2 | 3;
  /** Step-2 mapping payload (the raw text never round-trips from the server). */
  parsed?: ParsedCsv;
  /** Step-3 row classification. */
  preview?: ImportPreview;
  /** Final "Importados: N · Duplicados: M · Errores: K". */
  summary?: string;
}

/** Spanish feedback for the import service's typed errors. */
function mapImportError(error: ImportMutationError): string {
  switch (error) {
    case "too_large":
      return "El archivo supera el máximo de 2 MB.";
    case "too_many_rows":
      return `El archivo supera el máximo de ${IMPORT_MAX_ROWS} filas por importación.`;
    case "empty_file":
      return "El CSV debe tener una fila de encabezado y al menos una fila de datos.";
    case "forbidden":
      return "Solo los administradores pueden importar movimientos.";
    case "category_kind_mismatch":
      return "La categoría no corresponde al tipo de movimiento elegido.";
    case "member_inactive":
      return "El integrante seleccionado está inactivo.";
    case "not_found":
      return "Alguno de los datos seleccionados ya no existe. Recarga e intenta de nuevo.";
  }
}

function indexFrom(formData: FormData, key: string): number {
  const value = Number(formData.get(key));
  return Number.isInteger(value) && value >= 0 ? value : -1;
}

function readImportMapping(formData: FormData): ImportMapping {
  const rawNote = formData.get("noteIndex");
  const note = rawNote === null || rawNote === "" ? null : Number(rawNote);
  return {
    dateIndex: indexFrom(formData, "dateIndex"),
    amountIndex: indexFrom(formData, "amountIndex"),
    noteIndex: note !== null && Number.isInteger(note) && note >= 0 ? note : null,
  };
}

function readImportGlobals(formData: FormData): ImportGlobals {
  return {
    type: formData.get("type") === "income" ? "income" : "expense",
    categoryId: String(formData.get("categoryId") ?? ""),
    memberId: String(formData.get("memberId") ?? ""),
    scope: formData.get("scope") === "individual" ? "individual" : "common",
  };
}

export async function importMovementsAction(
  prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const user = await requireUser();
  try {
    requireAdmin(user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { error: mapImportError("forbidden") };
    throw error;
  }

  const raw = String(formData.get("csv") ?? "");
  const step = String(formData.get("step") ?? "parse");

  // Unknown steps never reach a DB write: the state machine rejects instead
  // of falling through to the commit branch (client-controlled field).
  if (step !== "parse" && step !== "preview" && step !== "import") {
    return { error: "La importación se cerró de forma inesperada. Volvé a empezar." };
  }

  // Paso 1 → 2: parse + detect + guess.
  if (step === "parse") {
    const parsed = parseImportCsv(raw);
    if (!parsed.ok) return { error: mapImportError(parsed.error) };
    return { step: 2, parsed: parsed.parsed };
  }

  const mapping = readImportMapping(formData);
  const globals = readImportGlobals(formData);
  // Empty integrante = the acting admin (same default as the movement form).
  const withMember: ImportGlobals = {
    ...globals,
    memberId: globals.memberId === "" ? user.id : globals.memberId,
  };
  // Guard the uuid cast: an untouched category select must fail as copy, not
  // as a raw Postgres "invalid input syntax" crash.
  if (!UUID_RE.test(withMember.categoryId)) {
    return { step: prev.step, parsed: prev.parsed, error: "Elegí una categoría para la importación." };
  }

  // Paso 2 → 3: classify every row (no writes).
  if (step === "preview") {
    const preview = await previewImport(getDb(), raw, mapping, withMember);
    if (!preview.ok) return { error: mapImportError(preview.error) };
    return { step: 3, parsed: prev.parsed, preview: preview.preview };
  }

  // Paso 3 → commit: insert the accepted rows.
  const result = await commitImport(
    getDb(),
    user,
    raw,
    mapping,
    withMember,
    formData.get("includeDuplicates") === "1",
  );
  if (!result.ok) return { error: mapImportError(result.error) };
  refresh();
  return {
    step: 3,
    parsed: prev.parsed,
    summary: `Importados: ${result.importados} · Duplicados: ${result.duplicados} · Errores: ${result.errores}`,
  };
}
