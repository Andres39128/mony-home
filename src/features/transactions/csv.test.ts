import { describe, expect, it } from "vitest";
import { movementsToCsv } from "@/features/transactions/csv";
import type { TransactionView } from "@/features/transactions/service";

/**
 * Pure suite: CSV serialization contract (BOM, header, es-AR decimal comma,
 * RFC 4180 quoting, row order preserved).
 */
function row(overrides: Partial<TransactionView> = {}): TransactionView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    date: "2026-09-10",
    amountCents: 123_456,
    type: "expense",
    scope: "common",
    note: null,
    categoryId: null,
    categoryName: null,
    categoryColor: null,
    memberId: "m1",
    memberName: "Mate",
    groupId: null,
    groupName: null,
    needsDetails: false,
    receiptId: null,
    ...overrides,
  };
}

describe("movementsToCsv", () => {
  it("emits a UTF-8 BOM, the header row and es-AR comma decimals", () => {
    const csv = movementsToCsv([
      row(),
      row({
        type: "income",
        amountCents: 1_000_000,
        categoryName: "Sueldo",
        scope: "individual",
        groupName: "Vacaciones",
        note: "Sueldo de septiembre",
        receiptId: "r1",
      }),
    ]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, first, second] = csv.slice(1).split("\r\n");
    expect(header).toBe("Fecha,Tipo,Monto,Categoría,Integrante,Ámbito,Grupo,Nota,Comprobante");
    // The decimal comma forces quoting the amount (RFC 4180) so Excel
    // keeps it as ONE field instead of splitting at the comma.
    expect(first).toBe('2026-09-10,Gasto,"1234,56",,Mate,Común,,,no');
    expect(second).toBe(
      '2026-09-10,Ingreso,"10000,00",Sueldo,Mate,Individual,Vacaciones,Sueldo de septiembre,sí',
    );
  });

  it("quotes fields containing separators, quotes or newlines", () => {
    const csv = movementsToCsv([
      row({ note: 'Nota con, coma y "comillas"' }),
      row({ note: "Línea\nnueva" }),
    ]);
    expect(csv).toContain('"Nota con, coma y ""comillas"""');
    expect(csv).toContain('"Línea\nnueva"');
  });

  it("preserves the caller's row order (list order, no re-sorting)", () => {
    const lines = movementsToCsv([row({ date: "2026-09-20" }), row({ date: "2026-09-05" })])
      .slice(1)
      .trimEnd()
      .split("\r\n");
    expect(lines[1]).toContain("2026-09-20");
    expect(lines[2]).toContain("2026-09-05");
  });
});
