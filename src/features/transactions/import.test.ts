import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, transactions, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import type { SessionUser } from "@/lib/auth";
import {
  IMPORT_MAX_ROWS,
  commitImport,
  guessColumns,
  parseImportCsv,
  parseImportDate,
  previewImport,
  type ImportGlobals,
  type ImportMapping,
} from "@/features/transactions/import";

const MAPPING: ImportMapping = { dateIndex: 0, amountIndex: 1, noteIndex: 2 };

describe("parseImportCsv + guessColumns + parseImportDate (pure)", () => {
  it("detects the delimiter, header and first 5 sample rows", () => {
    const result = parseImportCsv("Fecha;Valor;Nota\n02/01/2026;1000;uno\n03/01/2026;2000;dos\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.delimiter).toBe(";");
    expect(result.parsed.header).toEqual(["Fecha", "Valor", "Nota"]);
    expect(result.parsed.sample).toHaveLength(2);
    expect(result.parsed.guess).toEqual({ date: 0, amount: 1, note: 2 });
  });

  it("guesses english headers and leaves unknown columns null", () => {
    expect(guessColumns(["Date", "Amount", "Description"])).toEqual({ date: 0, amount: 1, note: 2 });
    expect(guessColumns(["Valor", "Concepto", "Fecha de pago"])).toEqual({ date: 2, amount: 0, note: 1 });
    expect(guessColumns(["colores", "numeros"])).toEqual({ date: null, amount: null, note: null });
  });

  it("accepts ISO, DD/MM/YYYY and 2-digit-year dates; rejects impossible ones", () => {
    expect(parseImportDate("2026-01-02")).toBe("2026-01-02");
    expect(parseImportDate("02/01/2026")).toBe("2026-01-02");
    expect(parseImportDate("2/1/99")).toBe("2099-01-02");
    expect(parseImportDate("31/02/2026")).toBeNull();
    expect(parseImportDate("ayer")).toBeNull();
  });

  it("enforces the size and row caps and the header requirement", () => {
    expect(parseImportCsv("x".repeat(2 * 1024 * 1024 + 1))).toEqual({ ok: false, error: "too_large" });
    expect(parseImportCsv("Fecha,Monto\n")).toEqual({ ok: false, error: "empty_file" });
    const tooMany = ["Fecha,Monto,Nota", ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => "2026-01-02,100,x")].join("\n");
    expect(parseImportCsv(tooMany)).toEqual({ ok: false, error: "too_many_rows" });
  });
});

describe("import service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let expenseCategoryId: string;
  let incomeCategoryId: string;

  const RAW = [
    "fecha,monto,nota",
    "2026-09-01,1500,super",
    "05/09/2026,2000, farmacia ",
    "07/09/26,3000,",
  ].join("\n");

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;

    const [adminRow] = await db
      .insert(users)
      .values({ username: "andres", name: "Andrés", passwordHash: "x", role: "admin" })
      .returning();
    const [memberRow] = await db
      .insert(users)
      .values({ username: "sofi", name: "Sofi", passwordHash: "x" })
      .returning();
    admin = { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: "admin" };
    member = { id: memberRow.id, username: memberRow.username, name: memberRow.name, role: "member" };

    const [expense] = await db.insert(categories).values({ name: "Mercado", kind: "expense" }).returning();
    const [income] = await db.insert(categories).values({ name: "Sueldo", kind: "income" }).returning();
    expenseCategoryId = expense.id;
    incomeCategoryId = income.id;
  });

  afterAll(async () => {
    await client.close();
  });

  const globals = (overrides: Partial<ImportGlobals> = {}): ImportGlobals => ({
    type: "expense",
    categoryId: expenseCategoryId,
    memberId: admin.id,
    scope: "common",
    ...overrides,
  });

  it("imports the nuevos with absolute amounts and shared globals", async () => {
    const result = await commitImport(appDb, admin, RAW, MAPPING, globals(), false);
    expect(result).toEqual({ ok: true, importados: 3, duplicados: 0, errores: 0 });

    const rows = await db.select().from(transactions).orderBy(transactions.date);
    expect(rows).toHaveLength(3);
    // Amounts parse via the shared AR parser: '1500' → 1500 pesos = 150000 cents.
    expect(rows.map((row) => [row.date, row.amountCents, row.note])).toEqual([
      ["2026-09-01", 150_000, "super"],
      ["2026-09-05", 200_000, "farmacia"],
      ["2026-09-07", 300_000, null],
    ]);
    expect(rows[0]).toMatchObject({
      type: "expense",
      categoryId: expenseCategoryId,
      memberId: admin.id,
      scope: "common",
      paymentMethod: "cash",
      needsDetails: false,
      groupId: null,
    });
  });

  it("flags duplicates against the ledger and inside the file; errors never import", async () => {
    // Existing row: same fecha+monto, note with different case/spacing → dup.
    await db.insert(transactions).values({
      date: "2026-09-01",
      amountCents: 150_000,
      type: "expense",
      categoryId: expenseCategoryId,
      memberId: admin.id,
      note: "SUPER   mercado",
    });
    const raw = [
      "fecha,monto,nota",
      "2026-09-01,1500,super mercado", // dup (ya existe)
      "2026-09-02,500,café",
      "2026-09-02,500,café", // dup (repetida en el archivo)
      "ayer,500,mal fecha",
      "2026-09-03,-500,negativo",
      "2026-09-04,1.234,ambiguo",
      "2026-09-05,100", // fila incompleta
    ].join("\n");

    const preview = await previewImport(appDb, raw, MAPPING, globals());
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview).toMatchObject({ nuevos: 1, duplicados: 2, errores: 4 });
    expect(preview.preview.rows.find((row) => row.motivo === "ya existe")?.status).toBe("duplicado");
    expect(preview.preview.rows.find((row) => row.motivo === "repetida en el archivo")?.status).toBe("duplicado");

    const result = await commitImport(appDb, admin, raw, MAPPING, globals(), false);
    expect(result).toEqual({ ok: true, importados: 1, duplicados: 2, errores: 4 });
    // Only the nuevo landed: the ledger dup and the in-file dup stay out.
    const allNotes = (await db.select().from(transactions)).map((row) => row.note);
    expect(allNotes.filter((note) => note === "café")).toHaveLength(1);
    expect(allNotes).not.toContain("super mercado");
  });

  it("imports flagged duplicates only when explicitly requested", async () => {
    const raw = ["fecha,monto,nota", "2026-09-10,700,repetido", "2026-09-10,700,repetido"].join("\n");
    const result = await commitImport(appDb, admin, raw, MAPPING, globals(), true);
    // duplicados still reports the DETECTED flag even when it gets imported.
    expect(result).toEqual({ ok: true, importados: 2, duplicados: 1, errores: 0 });
    expect(
      (await db.select().from(transactions).where(eq(transactions.note, "repetido"))).length,
    ).toBe(2);
  });

  it("truncates long notes to 200 characters", async () => {
    const raw = `fecha,monto,nota\n2026-09-11,800,${"x".repeat(250)}`;
    const result = await commitImport(appDb, admin, raw, MAPPING, globals(), false);
    expect(result).toEqual({ ok: true, importados: 1, duplicados: 0, errores: 0 });
    const [row] = await db.select().from(transactions).where(eq(transactions.date, "2026-09-11"));
    expect(row?.note).toHaveLength(200);
  });

  it("rejects the row cap at commit time", async () => {
    const raw = [
      "fecha,monto,nota",
      ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `2026-08-15,100,fila ${i}`),
    ].join("\n");
    expect(await commitImport(appDb, admin, raw, MAPPING, globals(), false)).toEqual({
      ok: false,
      error: "too_many_rows",
    });
  });

  it("is admin-only", async () => {
    expect(
      await commitImport(appDb, member, RAW, MAPPING, globals(), false),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("enforces the category-kind match and the member state once (globals)", async () => {
    expect(
      await commitImport(appDb, admin, RAW, MAPPING, globals({ categoryId: incomeCategoryId }), false),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
    expect(
      await commitImport(appDb, admin, RAW, MAPPING, globals({ memberId: "00000000-0000-0000-0000-000000000000" }), false),
    ).toEqual({ ok: false, error: "not_found" });

    await db.update(users).set({ isActive: false }).where(eq(users.username, "sofi"));
    const [sofi] = await db.select().from(users).where(eq(users.username, "sofi"));
    expect(
      await commitImport(appDb, admin, RAW, MAPPING, globals({ memberId: sofi.id }), false),
    ).toEqual({ ok: false, error: "member_inactive" });
    await db.update(users).set({ isActive: true }).where(eq(users.username, "sofi"));
  });

  it("flags every row as an error when the mapping points outside the header", async () => {
    const preview = await previewImport(appDb, RAW, { dateIndex: 9, amountIndex: 1, noteIndex: null }, globals());
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.errores).toBe(3);
    expect(preview.preview.rows[0].motivo).toContain("mapeo");
  });

  it("previews without writing anything", async () => {
    const before = (await db.select().from(transactions).where(and(eq(transactions.note, "preview")))).length;
    const preview = await previewImport(
      appDb,
      "fecha,monto,nota\n2026-09-20,900,preview",
      MAPPING,
      globals(),
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.nuevos).toBe(1);
    const after = (await db.select().from(transactions).where(and(eq(transactions.note, "preview")))).length;
    expect(after).toBe(before);
  });
});
