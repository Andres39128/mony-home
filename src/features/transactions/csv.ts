/**
 * CSV serialization of movements for the export route (RFC 4180 quoting,
 * es-AR decimal comma, UTF-8 BOM so Excel detects the encoding). Pure and
 * framework-free so it is testable without a request.
 */
import { centsToNumber } from "@/lib/money";
import type { TransactionView } from "@/features/transactions/service";

const BOM = "\uFEFF";
const HEADER = [
  "Fecha",
  "Tipo",
  "Monto",
  "Categoría",
  "Integrante",
  "Ámbito",
  "Grupo",
  "Nota",
  "Comprobante",
] as const;

/**
 * Quote a field only when needed (separator, quote or newline) and double
 * embedded quotes, per RFC 4180. Before quoting, a leading formula trigger
 * (= + - @ TAB CR — Excel/LibreOffice evaluate them as formulas) is
 * neutralized with a single apostrophe prefix, so user-settable columns
 * (nota, integrante) cannot inject spreadsheet formulas.
 */
function csvField(value: string): string {
  const neutralized = value.replace(/^([=+\-@\t\r])/, "'$1");
  return /[",;\n\r]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
}

/** Cents → '1234,56' (es-AR decimal comma, no currency symbol). */
function amountField(cents: number): string {
  return centsToNumber(cents).toFixed(2).replace(".", ",");
}

/** One CSV line per movement, in the order the list query returned them. */
export function movementsToCsv(rows: TransactionView[]): string {
  const lines = [HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.date,
        row.type === "income" ? "Ingreso" : "Gasto",
        amountField(row.amountCents),
        row.categoryName ?? "",
        row.memberName,
        row.scope === "common" ? "Común" : "Individual",
        row.groupName ?? "",
        row.note ?? "",
        row.receiptId ? "sí" : "no",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return BOM + lines.join("\r\n") + "\r\n";
}
