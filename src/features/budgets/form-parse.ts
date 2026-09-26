/**
 * Pure FormData → budgets-action result parsing.
 *
 * Extracted from actions.ts so the validation is unit-testable without the
 * "use server" + session-adapter coupling (same pattern as transactions'
 * filters.ts). Zod is the trust boundary here; the service re-validates
 * (defense in depth) and stays untouched.
 *
 * Amounts stay es-AR free text — the editor PREFILLS formatCents() output
 * ("$ 1.500,75") — so the Zod amount check delegates to the sanctioned
 * parser (money.parseAmountToCents via parseAmountCents) instead of
 * z.coerce.number(), which would reject every prefill. Mapping keeps the
 * existing user-facing copy: ambiguous → the guided message, anything else
 * unparseable (or negative) → the generic invalid-amount message.
 */
import { z } from "zod";
import type { BudgetEntryInput } from "@/features/budgets/service";
import {
  AMBIGUOUS_AMOUNT_MESSAGE,
  INVALID_AMOUNT_MESSAGE,
  parseAmountCents,
} from "@/lib/money-errors";

/** Inputs are named `amounts.<categoryId>`; one form covers every category. */
const AMOUNT_PREFIX = "amounts.";

const INVALID_MONTH_MESSAGE = "El mes indicado no es válido.";
const INVALID_CATEGORY_MESSAGE = "Categoría inválida.";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Non-empty es-AR free text that parses to a non-negative cent amount. */
const amountSchema = z.string().superRefine((raw, ctx) => {
  const cents = parseAmountCents(raw);
  if (cents === "ambiguous_amount") {
    ctx.addIssue({ code: "custom", message: AMBIGUOUS_AMOUNT_MESSAGE });
  } else if (cents === "invalid_amount" || cents < 0) {
    ctx.addIssue({ code: "custom", message: INVALID_AMOUNT_MESSAGE });
  }
});

const budgetEntrySchema = z.object({
  categoryId: z.uuid({ message: INVALID_CATEGORY_MESSAGE }),
  amount: amountSchema,
});

/** Failed-parse result: either a single message or per-field errors. */
export type ParseFailure =
  | { ok: false; error: string }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Parse just the hidden `month` input — the copy-previous-month form carries
 * no amount fields, so running the full budget parse there would reject
 * valid submissions. The service still re-validates the month.
 */
export function parseMonth(formData: FormData): { ok: true; month: string } | ParseFailure {
  const month = monthSchema.safeParse(formData.get("month"));
  if (!month.success) return { ok: false, error: INVALID_MONTH_MESSAGE };
  return { ok: true, month: month.data };
}

type ParseBudgetFormResult =
  | { ok: true; month: string; entries: BudgetEntryInput[] }
  | ParseFailure;

export function parseBudgetForm(formData: FormData): ParseBudgetFormResult {
  const month = parseMonth(formData);
  if (!month.ok) return month;

  const fieldErrors: Record<string, string> = {};
  const entries: BudgetEntryInput[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(AMOUNT_PREFIX)) continue;
    const raw = String(value).trim();
    // An untouched input means "no budget" (0), not a parse error.
    const parsed = budgetEntrySchema.safeParse({
      categoryId: key.slice(AMOUNT_PREFIX.length),
      amount: raw === "" ? "0" : raw,
    });
    if (!parsed.success) {
      fieldErrors[key] = parsed.error.issues[0]?.message ?? INVALID_AMOUNT_MESSAGE;
      continue;
    }
    entries.push(parsed.data);
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return { ok: true, month: month.month, entries };
}
