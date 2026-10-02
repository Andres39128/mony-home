/**
 * CSV import service (F5) — parse, preview and commit imported movements.
 *
 * The imported movements ARE the record: no staging table, no migration.
 * The server owns ALL parsing (trust boundary — the client only ships raw
 * text and mapping indices). One `type` for the whole import keeps it simple
 * (mixed files = two imports), so amounts are absolute: a negative cell is a
 * row error, never a sign hint.
 *
 * Dedup: normalized key (ISO date | amountCents | lowercased-collapsed
 * note) checked against existing COMPLETED transactions loaded with ONE
 * indexed range query spanning the file's min..max date ±1 day. Rows that
 * repeat inside the same file count as duplicates too (importing the same
 * row twice from one paste is never what anyone wants).
 *
 * Commit reuses the shared movement invariants (category kind matches the
 * type, member active) validated ONCE for the globals, then bulk-inserts the
 * accepted rows in one transaction — always paymentMethod 'cash',
 * needsDetails false, no group, no recurrence.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import { categories, transactions, users } from "@/db/schema";
import type { Database } from "@/db";
import type { SessionUser } from "@/lib/auth";
import { ForbiddenError, requireAdmin } from "@/lib/auth";
import { dayIndexOfIso, isoOfDayIndex } from "@/lib/date";
import { AMBIGUOUS_AMOUNT_MESSAGE, INVALID_AMOUNT_MESSAGE, parseAmountCents } from "@/lib/money-errors";
import { detectDelimiter, parseCsv, type CsvDelimiter } from "@/lib/csv";

/** Hard size cap for the pasted/uploaded file (same cap as receipts). */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** Hard row cap per import (data rows, header excluded). */
export const IMPORT_MAX_ROWS = 2000;

const DATE_HINTS = ["fecha", "date"];
const AMOUNT_HINTS = ["monto", "amount", "valor"];
const NOTE_HINTS = ["nota", "descripcion", "descripción", "description", "concepto"];

/** 0-based column indices picked on the mapping step. */
export interface ColumnGuess {
  date: number | null;
  amount: number | null;
  note: number | null;
}

/** What the mapping screen needs — the raw text stays client-side only. */
export interface ParsedCsv {
  delimiter: CsvDelimiter;
  header: string[];
  /** First data rows for the mapping preview. */
  sample: string[][];
  guess: ColumnGuess;
}

export type ImportParseError = "too_large" | "too_many_rows" | "empty_file";

export type ImportParseResult =
  | { ok: true; parsed: ParsedCsv }
  | { ok: false; error: ImportParseError };

/** Case-insensitive substring match of header names against known hints. */
export function guessColumns(header: string[]): ColumnGuess {
  const normalized = header.map((name) => name.trim().toLowerCase());
  const find = (hints: string[]): number | null => {
    const index = normalized.findIndex((name) => hints.some((hint) => name.includes(hint)));
    return index === -1 ? null : index;
  };
  return { date: find(DATE_HINTS), amount: find(AMOUNT_HINTS), note: find(NOTE_HINTS) };
}

/** Step 1 trust boundary: the server parses and caps the raw text. */
export function parseImportCsv(raw: string): ImportParseResult {
  if (Buffer.byteLength(raw, "utf8") > IMPORT_MAX_BYTES) return { ok: false, error: "too_large" };
  const delimiter = detectDelimiter(raw);
  const rows = dataRowsFromRaw(raw, delimiter);
  if (rows.length < 2) return { ok: false, error: "empty_file" };
  if (rows.length - 1 > IMPORT_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  const [header, ...data] = rows;
  return { ok: true, parsed: { delimiter, header, sample: data.slice(0, 5), guess: guessColumns(header) } };
}

/** 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'DD/MM/YY' → ISO date, or null. */
export function parseImportDate(input: string): string | null {
  const raw = input.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (slashed) {
    const year = Number(slashed[3]);
    return calendarDate(year < 100 ? 2000 + year : year, Number(slashed[2]), Number(slashed[1]));
  }
  return null;
}

/** Rejects impossible calendar days (31/02) via a UTC round-trip. */
function calendarDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Non-blank CSV rows of a raw import (blank lines are separators, not data). */
function dataRowsFromRaw(raw: string, delimiter: CsvDelimiter): string[][] {
  return parseCsv(raw, delimiter).filter((row) => row.some((cell) => cell.trim() !== ""));
}

export interface ImportMapping {
  dateIndex: number;
  amountIndex: number;
  /** null = the import has no note column. */
  noteIndex: number | null;
}

export interface ImportGlobals {
  type: "income" | "expense";
  categoryId: string;
  /** Empty string = the acting admin (resolved by the action layer). */
  memberId: string;
  scope: "individual" | "common";
}

export type ImportRowStatus = "nuevo" | "duplicado" | "error";

export interface ImportRowPreview {
  /** 1-based data row number (header excluded) — stable across re-previews. */
  line: number;
  date: string | null;
  amountCents: number | null;
  note: string | null;
  status: ImportRowStatus;
  /** Error reason, or the duplicate flavor ("ya existe" / in-file repeat). */
  motivo?: string;
}

export interface ImportPreview {
  rows: ImportRowPreview[];
  nuevos: number;
  duplicados: number;
  errores: number;
}

export type ImportMutationError =
  | "forbidden"
  | "category_kind_mismatch"
  | "member_inactive"
  | "not_found"
  | ImportParseError;

/** The dedup identity: fecha + monto + nota normalized (lowercase, collapsed spaces). */
function dedupKey(date: string, amountCents: number, note: string | null): string {
  return `${date}|${amountCents}|${(note ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * ONE indexed query over completed transactions in the file's date range
 * extended ±1 day (re-exports often drift a day). Returns the set of keys.
 */
async function loadExistingKeys(
  db: Pick<Database, "select">,
  dates: string[],
): Promise<Set<string>> {
  if (dates.length === 0) return new Set();
  const min = dates.reduce((a, b) => (a < b ? a : b));
  const max = dates.reduce((a, b) => (a > b ? a : b));
  const rows = await db
    .select({
      date: transactions.date,
      amountCents: transactions.amountCents,
      note: transactions.note,
    })
    .from(transactions)
    .where(
      and(
        // Pending quick-capture rows are placeholders, not money.
        eq(transactions.needsDetails, false),
        gte(transactions.date, isoOfDayIndex(dayIndexOfIso(min) - 1)),
        lte(transactions.date, isoOfDayIndex(dayIndexOfIso(max) + 1)),
      ),
    );
  return new Set(rows.map((row) => dedupKey(row.date, row.amountCents, row.note)));
}

/**
 * Classifies every data row (parse → validate → dedup). Errors never import;
 * duplicates are flagged but insertable on explicit request.
 */
async function classifyRows(
  db: Pick<Database, "select">,
  raw: string,
  mapping: ImportMapping,
): Promise<ImportPreview | { error: ImportParseError }> {
  const parsed = parseImportCsv(raw);
  if (!parsed.ok) return parsed;

  const { header, delimiter } = parsed.parsed;
  const dataRows = dataRowsFromRaw(raw, delimiter);
  dataRows.shift(); // header

  const maxNeeded = Math.max(mapping.dateIndex, mapping.amountIndex, mapping.noteIndex ?? -1);
  const invalidMapping =
    mapping.dateIndex < 0 ||
    mapping.amountIndex < 0 ||
    mapping.dateIndex >= header.length ||
    mapping.amountIndex >= header.length ||
    (mapping.noteIndex !== null &&
      (mapping.noteIndex < 0 || mapping.noteIndex >= header.length));
  if (invalidMapping) {
    // A mapping pointing outside the header cannot classify anything.
    return {
      rows: dataRows.map((_, index) => ({
        line: index + 1,
        date: null,
        amountCents: null,
        note: null,
        status: "error",
        motivo: "El mapeo de columnas no corresponde al archivo.",
      })),
      nuevos: 0,
      duplicados: 0,
      errores: dataRows.length,
    };
  }

  // First pass: validate and collect dates for the dedup window.
  const rows: ImportRowPreview[] = [];
  const validDates: string[] = [];
  for (const [index, cells] of dataRows.entries()) {
    const line = index + 1;
    if (cells.length <= maxNeeded) {
      rows.push({
        line,
        date: null,
        amountCents: null,
        note: null,
        status: "error",
        motivo: "La fila no tiene todas las columnas mapeadas.",
      });
      continue;
    }
    const date = parseImportDate(cells[mapping.dateIndex]);
    if (!date) {
      rows.push({
        line,
        date: null,
        amountCents: null,
        note: null,
        status: "error",
        motivo: "Fecha inválida (usá AAAA-MM-DD o DD/MM/AAAA).",
      });
      continue;
    }
    const amountRaw = cells[mapping.amountIndex].trim();
    const cents = parseAmountCents(amountRaw);
    // The type is global, so amounts are absolute: negatives are a row error.
    if (typeof cents === "number" && cents < 0) {
      rows.push({
        line,
        date,
        amountCents: null,
        note: null,
        status: "error",
        motivo: "El monto no puede ser negativo: el tipo (ingreso/gasto) se elige para toda la importación.",
      });
      continue;
    }
    if (cents === "ambiguous_amount") {
      rows.push({
        line,
        date,
        amountCents: null,
        note: null,
        status: "error",
        motivo: AMBIGUOUS_AMOUNT_MESSAGE,
      });
      continue;
    }
    if (cents === "invalid_amount" || cents === 0) {
      rows.push({
        line,
        date,
        amountCents: null,
        note: null,
        status: "error",
        motivo: INVALID_AMOUNT_MESSAGE,
      });
      continue;
    }
    const note = mapping.noteIndex === null ? null : cells[mapping.noteIndex].trim().slice(0, 200);
    rows.push({ line, date, amountCents: cents, note: note || null, status: "nuevo" });
    validDates.push(date);
  }

  const existing = await loadExistingKeys(db, validDates);
  const seen = new Set<string>();
  let nuevos = 0;
  let duplicados = 0;
  let errores = 0;
  for (const row of rows) {
    if (row.status !== "nuevo" || row.date === null || row.amountCents === null) {
      errores++;
      continue;
    }
    const key = dedupKey(row.date, row.amountCents, row.note);
    if (existing.has(key)) {
      row.status = "duplicado";
      row.motivo = "ya existe";
    } else if (seen.has(key)) {
      row.status = "duplicado";
      row.motivo = "repetida en el archivo";
    } else {
      seen.add(key);
      nuevos++;
      continue;
    }
    duplicados++;
  }
  return { rows, nuevos, duplicados, errores };
}

/** Step 3 preview: classification only, no writes. */
export async function previewImport(
  db: Pick<Database, "select">,
  raw: string,
  mapping: ImportMapping,
  globals: ImportGlobals,
): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: ImportMutationError }> {
  const globalsError = await checkGlobals(db, globals);
  if (globalsError) return { ok: false, error: globalsError };
  const classified = await classifyRows(db, raw, mapping);
  if ("error" in classified) return { ok: false, error: classified.error };
  return { ok: true, preview: classified };
}

/** Globals are validated ONCE with the same rules as createTransaction. */
async function checkGlobals(
  db: Pick<Database, "select">,
  globals: ImportGlobals,
): Promise<ImportMutationError | null> {
  const [category] = await db
    .select({ kind: categories.kind })
    .from(categories)
    .where(eq(categories.id, globals.categoryId))
    .limit(1);
  if (!category) return "not_found";
  if (category.kind !== globals.type) return "category_kind_mismatch";
  const [member] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, globals.memberId))
    .limit(1);
  if (!member) return "not_found";
  if (!member.isActive) return "member_inactive";
  return null;
}

export interface ImportCommitResult {
  ok: true;
  importados: number;
  duplicados: number;
  errores: number;
}

/**
 * Admin-only commit: validates globals, classifies and inserts the accepted
 * rows (nuevos, plus duplicados only on explicit request) in ONE transaction
 * — a single multi-row INSERT. Everything validated, nothing half-imported.
 */
export async function commitImport(
  db: Database,
  user: SessionUser,
  raw: string,
  mapping: ImportMapping,
  globals: ImportGlobals,
  includeDuplicates: boolean,
): Promise<ImportCommitResult | { ok: false; error: ImportMutationError }> {
  try {
    requireAdmin(user);
  } catch (error) {
    if (error instanceof ForbiddenError) return { ok: false, error: "forbidden" };
    throw error;
  }
  const preview = await previewImport(db, raw, mapping, globals);
  if (!preview.ok) return preview;

  const accepted = preview.preview.rows.filter(
    (row) => row.status === "nuevo" || (includeDuplicates && row.status === "duplicado"),
  );
  if (accepted.length > 0) {
    await db.transaction(async (tx) => {
      await tx.insert(transactions).values(
        accepted.map((row) => ({
          date: row.date!,
          amountCents: row.amountCents!,
          type: globals.type,
          categoryId: globals.categoryId,
          memberId: globals.memberId,
          scope: globals.scope,
          note: row.note,
          paymentMethod: "cash" as const,
          needsDetails: false,
        })),
      );
    });
  }
  return {
    ok: true,
    importados: accepted.length,
    duplicados: preview.preview.duplicados,
    errores: preview.preview.errores,
  };
}
