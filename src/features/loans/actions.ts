"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { adminGuard, requireUser } from "@/features/auth/session";
import {
  addLoanPayment,
  createLoan,
  loanPaymentSchema,
  loanSchema,
  outstandingSchema,
  removeLoan,
  toggleLoanActive,
  updateLoan,
  updateOutstanding,
} from "@/features/loans/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";
import { amountFieldError } from "@/lib/money-errors";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar préstamos.";

/** Loan and payment mutations both change /prestamos and the dashboard KPI. */
function revalidateLoans(): void {
  revalidatePath("/prestamos");
  revalidatePath("/");
}

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mapLoanError(error: string): FormState {
  if (error === "invalid_principal") {
    return { fieldErrors: { principal: "El capital no es válido." } };
  }
  if (error === "invalid_rate") {
    return { fieldErrors: { annualRate: "La TNA no es válida (máximo 1000%)." } };
  }
  if (error === "invalid_outstanding") {
    return { fieldErrors: { outstanding: "El saldo no es válido." } };
  }
  if (error === "member_not_found") {
    return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
  }
  if (error === "loan_not_found") {
    return { error: "El préstamo no existe." };
  }
  if (error === "has_payments") {
    return {
      error:
        "No se puede eliminar: tiene pagos asociados. Se puede desactivar como alternativa.",
    };
  }
  if (error === "forbidden") return { error: ADMIN_REQUIRED_MESSAGE };
  return { error: "No se pudo guardar el préstamo." };
}

function readLoanForm(formData: FormData) {
  return {
    name: formData.get("name"),
    kind: formData.get("kind"),
    entity: formData.get("entity"),
    scope: formData.get("scope"),
    memberId: formData.get("memberId") ?? "",
    principal: formData.get("principal") ?? "",
    annualRate: formData.get("annualRate") ?? "",
  };
}

export async function createLoanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const parsed = loanSchema.safeParse(readLoanForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await createLoan(getDb(), guard.user, parsed.data);
  if (!result.ok) return mapLoanError(result.error);

  revalidateLoans();
  return { ok: true };
}

export async function updateLoanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Préstamo inválido." };

  const parsed = loanSchema.safeParse(readLoanForm(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await updateLoan(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapLoanError(result.error);

  revalidateLoans();
  return { ok: true };
}

export async function toggleLoanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Préstamo inválido." };

  const result = await toggleLoanActive(getDb(), guard.user, id);
  if (!result.ok) return mapLoanError(result.error);

  revalidateLoans();
  return { ok: true };
}

export async function deleteLoanAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Préstamo inválido." };

  const result = await removeLoan(getDb(), guard.user, id);
  if (!result.ok) return mapLoanError(result.error);

  revalidateLoans();
  return { ok: true };
}

export async function updateOutstandingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const guard = await adminGuard(ADMIN_REQUIRED_MESSAGE);
  if (!guard.ok) return guard;

  const id = idFrom(formData);
  if (!id) return { error: "Préstamo inválido." };

  const parsed = outstandingSchema.safeParse(String(formData.get("outstanding") ?? ""));
  if (!parsed.success) {
    return { fieldErrors: { outstanding: parsed.error.issues[0]?.message ?? "El saldo no es válido." } };
  }

  const result = await updateOutstanding(getDb(), guard.user, id, parsed.data);
  if (!result.ok) return mapLoanError(result.error);

  revalidateLoans();
  return { ok: true };
}

export async function addLoanPaymentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Any authenticated member may pay; the service pins attribution.
  const user = await requireUser();

  const loanId = idFrom(formData);
  if (!loanId) return { error: "Préstamo inválido." };

  const parsed = loanPaymentSchema.safeParse({
    amount: formData.get("amount"),
    date: formData.get("date") ?? "",
    note: formData.get("note") ?? "",
    // Quick-entry forms pin to the actor; admins may send memberId explicitly.
    memberId: formData.get("memberId") ?? "",
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error.issues) };

  const result = await addLoanPayment(getDb(), user, loanId, parsed.data);
  if (!result.ok) {
    if (result.error === "invalid_amount" || result.error === "ambiguous_amount") {
      return amountFieldError(result.error);
    }
    if (result.error === "loan_not_found") return { error: "El préstamo no existe." };
    if (result.error === "loan_inactive") {
      return { error: "El préstamo está inactivo: activalo para registrar pagos." };
    }
    if (result.error === "member_not_found") {
      return { fieldErrors: { memberId: "El integrante seleccionado no existe." } };
    }
    if (result.error === "system_category_missing") {
      return {
        error:
          "Falta la categoría de préstamos del sistema: ejecutá la carga inicial (db:seed) para crearla.",
      };
    }
    return { error: "No tenés permiso para registrar ese pago." };
  }

  revalidateLoans();
  return { ok: true };
}
