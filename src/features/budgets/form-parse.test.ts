import { describe, expect, it } from "vitest";
import { parseBudgetForm } from "@/features/budgets/form-parse";
import {
  AMBIGUOUS_AMOUNT_MESSAGE,
  INVALID_AMOUNT_MESSAGE,
} from "@/lib/money-errors";

/**
 * Pure suite: FormData → budgets-action result parsing. The Zod boundary
 * must keep the EXACT user-facing copy the action used to produce by hand.
 */
describe("parseBudgetForm", () => {
  const CAT_A = "0e1a9a4f-6d5e-4a1b-9c3f-2b7d8e0f1a2b";
  const CAT_B = "1f2b8b5f-7e6f-4b2c-8d4f-3c8e9f1a2b3c";

  function form(entries: Record<string, string>): FormData {
    const formData = new FormData();
    for (const [key, value] of Object.entries(entries)) formData.set(key, value);
    return formData;
  }

  it("accepts a valid month, es-AR amounts and untouched inputs (empty = 0)", () => {
    const result = parseBudgetForm(
      form({
        month: "2026-09",
        [`amounts.${CAT_A}`]: "1.234,56",
        [`amounts.${CAT_B}`]: "   ",
      }),
    );
    expect(result).toEqual({
      ok: true,
      month: "2026-09",
      entries: [
        { categoryId: CAT_A, amount: "1.234,56" },
        { categoryId: CAT_B, amount: "0" },
      ],
    });
  });

  it("ignores fields outside the amounts.<categoryId> namespace", () => {
    const result = parseBudgetForm(form({ month: "2026-09", other: "1.234,56" }));
    expect(result).toEqual({ ok: true, month: "2026-09", entries: [] });
  });

  it("rejects a malformed month with the existing form error", () => {
    for (const month of ["2026-13", "09-2026", "septiembre", "", "2026-9"]) {
      const result = parseBudgetForm(form({ month, [`amounts.${CAT_A}`]: "100" }));
      expect(result).toEqual({ ok: false, error: "El mes indicado no es válido." });
    }
  });

  it("rejects negative and unparseable amounts with the existing field error", () => {
    for (const amount of ["-5", "abc", "12.3.4"]) {
      const result = parseBudgetForm(form({ month: "2026-09", [`amounts.${CAT_A}`]: amount }));
      expect(result).toEqual({
        ok: false,
        fieldErrors: { [`amounts.${CAT_A}`]: INVALID_AMOUNT_MESSAGE },
      });
    }
  });

  it("keeps the guided ambiguous-amount copy for the one colliding shape", () => {
    const result = parseBudgetForm(form({ month: "2026-09", [`amounts.${CAT_A}`]: "1.234" }));
    expect(result).toEqual({
      ok: false,
      fieldErrors: { [`amounts.${CAT_A}`]: AMBIGUOUS_AMOUNT_MESSAGE },
    });
  });

  it("rejects a non-uuid category id in the field name with a field error", () => {
    const result = parseBudgetForm(form({ month: "2026-09", "amounts.not-a-uuid": "100" }));
    expect(result).toEqual({
      ok: false,
      fieldErrors: { "amounts.not-a-uuid": "Categoría inválida." },
    });
  });
});
