/**
 * Shared es-AR amount-parse error surface for services and server actions.
 *
 * Every free-text amount goes through money.parseAmountToCents (R2); THIS
 * module is the single place that turns parse failures into typed codes and
 * user-facing field messages — so an ambiguous input like '1.234' shows the
 * SAME guided copy in movements, savings, loans and budgets instead of a
 * generic "El monto no es válido.".
 */
import { AmbiguousAmountError, parseAmountToCents } from "@/lib/money";
import type { FormState } from "@/lib/form-state";

export type AmountParseResult = number | "invalid_amount" | "ambiguous_amount";

/**
 * Free-text amount → cents, or a typed error code. Positivity is NOT checked
 * here — callers enforce their own sign rules (movements/contributions/payments
 * require > 0; budgets allow 0).
 */
export function parseAmountCents(amount: string): AmountParseResult {
  try {
    return parseAmountToCents(amount);
  } catch (error) {
    return error instanceof AmbiguousAmountError ? "ambiguous_amount" : "invalid_amount";
  }
}

export const INVALID_AMOUNT_MESSAGE = "El monto no es válido.";

/** Guided copy for the one colliding shape ('1.234': thousands or 1.23?). */
export const AMBIGUOUS_AMOUNT_MESSAGE =
  "Monto ambiguo: para miles escribe 1234 o 1.234,00; para centavos usa la coma (1,23).";

/** Field error for the shared `amount` input, matching the typed code. */
export function amountFieldError(code: "invalid_amount" | "ambiguous_amount"): FormState {
  return {
    fieldErrors: {
      amount: code === "ambiguous_amount" ? AMBIGUOUS_AMOUNT_MESSAGE : INVALID_AMOUNT_MESSAGE,
    },
  };
}
