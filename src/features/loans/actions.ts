"use server";

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
  type BankConfigField,
} from "@/features/loans/service";
import { fieldErrorsFrom, type FormState } from "@/lib/form-state";
import { amountFieldError } from "@/lib/money-errors";

const ADMIN_REQUIRED_MESSAGE = "Solo los administradores pueden gestionar préstamos.";

/** Spanish field errors for bank calibration parse failures (D4). */
const BANK_FIELD_ERRORS: Record<BankConfigField, string> = {
  chargedRate: "La EA cobrada no es válida (máximo 1000%).",
  contractualRate: "La tasa pactada no es válida (máximo 1000%).",
  termMonths: "El plazo debe ser un número entero de meses.",
  fixedCuota: "La cuota fija no es válida.",
  cuotaDay: "El día de cuota debe ser un número entre 1 y 28.",
  propertyValue: "El valor del inmueble no es válido.",
  insuredBase: "La base asegurada no es válida.",
  lifeRatePerMillon: "La tasa de seguro de vida no es válida (máximo 9.999,99 por millón).",
  fireRatePerMillon: "La tasa de seguro de incendio no es válida (máximo 9.999,99 por millón).",
  moraRate: "La tasa de mora no es válida (máximo 1000%).",
  otherCharges: "Otros cargos no es un monto válido.",
};

function idFrom(formData: FormData): string | null {
  const id = formData.get("id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Maps any loan-service failure to a form state (bank errors carry a field). */
function mapLoanError(result: { error: string; field?: BankConfigField }): FormState {
  const { error, field } = result;
  if (error === "invalid_principal") {
    return { fieldErrors: { principal: "El capital no es válido." } };
  }
  if (error === "invalid_rate") {
    return { fieldErrors: { annualRate: "La TNA no es válida (máximo 1000%)." } };
  }
  if (error === "invalid_bank_config") {
    const key = field ?? "chargedRate";
    return { fieldErrors: { [key]: BANK_FIELD_ERRORS[key] } };
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
    // Bank calibration block (D4) — always sent; empty strings mean "off".
    amortizationMode: formData.get("amortizationMode") ?? "",
    chargedRate: formData.get("chargedRate") ?? "",
    contractualRate: formData.get("contractualRate") ?? "",
    termMonths: formData.get("termMonths") ?? "",
    fixedCuota: formData.get("fixedCuota") ?? "",
    cuotaDay: formData.get("cuotaDay") ?? "",
    propertyValue: formData.get("propertyValue") ?? "",
    insuredBase: formData.get("insuredBase") ?? "",
    lifeRatePerMillon: formData.get("lifeRatePerMillon") ?? "",
    fireRatePerMillon: formData.get("fireRatePerMillon") ?? "",
    moraRate: formData.get("moraRate") ?? "",
    otherCharges: formData.get("otherCharges") ?? "",
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
  if (!result.ok) return mapLoanError(result);
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
  if (!result.ok) return mapLoanError(result);
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
  if (!result.ok) return mapLoanError(result);
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
  if (!result.ok) return mapLoanError(result);
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
  if (!result.ok) return mapLoanError(result);
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
  return { ok: true };
}
