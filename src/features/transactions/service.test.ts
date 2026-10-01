import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import {
  categories,
  expenseGroups,
  loans,
  movementReceipts,
  transactions,
  users,
} from "@/db/schema";
import {
  PENDING_DETAILS_NOTE,
  RECEIPT_MAX_BYTES,
  createQuickTransaction,
  createTransaction,
  findOpeningBalance,
  getReceiptFile,
  listTransactions,
  listTransactionsPage,
  movementSchema,
  openingBalanceCents,
  openingBalanceSchema,
  quickMovementSchema,
  removeTransaction,
  setOpeningBalance,
  transactionTotals,
  updateTransaction,
} from "@/features/transactions/service";
import { todayIso } from "@/lib/date";
import type { MovementInput } from "@/features/transactions/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Transactions service suite: integrity rules (category kind, group status,
 * AR amount parsing, member ownership for edit/delete), filters, exact-cent
 * totals — against in-memory Postgres with the real migrations.
 *
 * Filter/totals assertions run against the pure fixture FIRST; successful
 * creates run afterwards so their rows can never pollute those assertions.
 */
describe("transactions service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let mate: SessionUser;
  let ana: SessionUser;
  let mateId: string;
  let anaId: string;
  let incomeCat: { id: string };
  let expenseCat: { id: string };
  let activeGroup: { id: string };
  let closedGroup: { id: string };
  let fixtureTx: { id: string };

  const MONTH = "2026-09";
  const GHOST = "00000000-0000-4000-8000-000000000000";

  /** Form-shaped raw input so zod defaults/transforms apply like a real submit. */
  function rawInput(overrides: Record<string, unknown> = {}) {
    return {
      date: "2026-08-10",
      amount: "100",
      type: "expense",
      categoryId: expenseCat.id,
      memberId: "",
      groupId: "",
      scope: "common",
      note: "",
      ...overrides,
    };
  }

  function parseInput(overrides: Record<string, unknown> = {}): MovementInput {
    return movementSchema.parse(rawInput(overrides));
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;

    const [adminRow] = await db
      .insert(users)
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    const [mateRow] = await db
      .insert(users)
      .values({ username: "mate", name: "Mate", passwordHash: "x", role: "member" })
      .returning();
    const [anaRow] = await db
      .insert(users)
      .values({ username: "ana", name: "Ana", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: adminRow.role };
    mate = { id: mateRow.id, username: mateRow.username, name: mateRow.name, role: mateRow.role };
    ana = { id: anaRow.id, username: anaRow.username, name: anaRow.name, role: anaRow.role };
    mateId = mateRow.id;
    anaId = anaRow.id;

    [incomeCat, expenseCat] = await db
      .insert(categories)
      .values([
        { name: "Sueldo", kind: "income" },
        { name: "Super", kind: "expense", color: "#16a34a" },
      ])
      .returning();

    [activeGroup, closedGroup] = await db
      .insert(expenseGroups)
      .values([
        { name: "Vacaciones", status: "active" },
        { name: "Viaje viejo", status: "closed" },
      ])
      .returning();

    // Mixed fixture for filters/totals, all inside 2026-09 except the last one.
    // The card purchase is cupo DEBT: totals must never count it as gasto.
    const [card] = await db
      .insert(loans)
      .values({
        name: "Visa Fixture",
        kind: "credit_card",
        entity: "Banco Fixture",
        scope: "common",
        principalCents: 0,
        amortizationMode: "revolving",
        creditLimitCents: 1_000_000,
      })
      .returning();
    const inserted = await db
      .insert(transactions)
      .values([
        {
          date: "2026-09-20",
          amountCents: 100_000,
          type: "income",
          categoryId: incomeCat.id,
          memberId: mateId,
          note: "Sueldo septiembre",
        },
        {
          date: "2026-09-10",
          amountCents: 25_000,
          type: "expense",
          categoryId: expenseCat.id,
          memberId: mateId,
          groupId: activeGroup.id,
          note: "Compra semanal",
        },
        {
          date: "2026-09-05",
          amountCents: 5_500,
          type: "expense",
          categoryId: expenseCat.id,
          memberId: anaId,
          groupId: closedGroup.id, // history may reference a closed group
        },
        {
          date: "2026-09-08",
          amountCents: 40_000,
          type: "expense",
          categoryId: expenseCat.id,
          memberId: mateId,
          paymentMethod: "card",
          cardLoanId: card.id,
          note: "Compra con tarjeta",
        },
        {
          date: "2026-10-01",
          amountCents: 999_999,
          type: "expense",
          categoryId: expenseCat.id,
          memberId: mateId,
        },
      ])
      .returning();
    fixtureTx = { id: inserted[1].id };
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists with each filter individually", async () => {
    const month = await listTransactions(appDb, { month: MONTH });
    expect(month.map((t) => t.date)).toEqual([
      "2026-09-20",
      "2026-09-10",
      "2026-09-08",
      "2026-09-05",
    ]);

    const byCategory = await listTransactions(appDb, { categoryId: expenseCat.id });
    expect(byCategory.map((t) => t.date)).toEqual([
      "2026-10-01",
      "2026-09-10",
      "2026-09-08",
      "2026-09-05",
    ]);

    const byMember = await listTransactions(appDb, { memberId: mateId });
    expect(byMember.map((t) => t.date)).toEqual([
      "2026-10-01",
      "2026-09-20",
      "2026-09-10",
      "2026-09-08",
    ]);

    const byActiveGroup = await listTransactions(appDb, { groupId: activeGroup.id });
    expect(byActiveGroup.map((t) => t.date)).toEqual(["2026-09-10"]);

    const byClosedGroup = await listTransactions(appDb, { groupId: closedGroup.id });
    expect(byClosedGroup.map((t) => t.date)).toEqual(["2026-09-05"]);

    const byType = await listTransactions(appDb, { type: "income" });
    expect(byType.map((t) => t.date)).toEqual(["2026-09-20"]);

    const byCard = await listTransactions(appDb, { paymentMethod: "card" });
    expect(byCard.map((t) => t.date)).toEqual(["2026-09-08"]);
    const byCash = await listTransactions(appDb, { paymentMethod: "cash" });
    expect(byCash.map((t) => t.date)).toEqual([
      "2026-10-01",
      "2026-09-20",
      "2026-09-10",
      "2026-09-05",
    ]);
  });

  it("lists with combined filters and joins display names", async () => {
    const rows = await listTransactions(appDb, { month: MONTH, memberId: mateId, type: "expense" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      categoryName: "Super",
      categoryColor: "#16a34a",
      memberName: "Mate",
      groupName: "Vacaciones",
      amountCents: 25_000,
    });
    // Card rows keep naming their revolving card (list is cash-agnostic).
    expect(rows[1]).toMatchObject({
      paymentMethod: "card",
      cardName: "Visa Fixture",
      amountCents: 40_000,
    });
  });

  it("computes cash-basis totals: card purchases stay out of the saldo", async () => {
    expect(await transactionTotals(appDb, { month: MONTH })).toEqual({
      incomeCents: 100_000,
      expenseCents: 30_500,
      cardExpenseCents: 40_000,
      balanceCents: 69_500,
    });
    expect(await transactionTotals(appDb, { month: MONTH, type: "income" })).toEqual({
      incomeCents: 100_000,
      expenseCents: 0,
      cardExpenseCents: 0,
      balanceCents: 100_000,
    });
    expect(await transactionTotals(appDb, { month: MONTH, memberId: anaId })).toEqual({
      incomeCents: 0,
      expenseCents: 5_500,
      cardExpenseCents: 0,
      balanceCents: -5_500,
    });
  });

  it("carries the opening balance from previous months", async () => {
    // Nothing before September → September opens at zero.
    expect(await openingBalanceCents(appDb, { month: MONTH })).toBe(0);
    // October opens with September's CASH net: 100.000 − 30.500 = 69.500.
    // The 40.000 card purchase never drags (it is card debt), and the
    // 2026-10-01 movement itself is NOT part of the opening (strictly before).
    expect(await openingBalanceCents(appDb, { month: "2026-10" })).toBe(69_500);
    // Same non-month filters apply: Ana's history before October is −5.500.
    expect(await openingBalanceCents(appDb, { month: "2026-10", memberId: anaId })).toBe(-5_500);
    // No month (or malformed) → no opening concept, 0.
    expect(await openingBalanceCents(appDb, {})).toBe(0);
    expect(await openingBalanceCents(appDb, { month: "nope" })).toBe(0);
  });

  it("matches a note substring case-insensitively (q filter)", async () => {
    const rows = await listTransactions(appDb, { month: MONTH, q: "COMPRA" });
    expect(rows.map((t) => t.note)).toEqual(["Compra semanal", "Compra con tarjeta"]);
    expect(await listTransactions(appDb, { month: MONTH, q: "sueldo" }).then((r) => r.map((t) => t.note)))
      .toEqual(["Sueldo septiembre"]);
    // Rows with no note never match.
    expect(await listTransactions(appDb, { month: MONTH, q: "zumba" })).toHaveLength(0);
  });

  it("treats LIKE wildcards in the search term as literals", async () => {
    // Unescaped, '%' would match every row and '_' any single char.
    expect(await listTransactions(appDb, { month: MONTH, q: "%" })).toHaveLength(0);
    expect(await listTransactions(appDb, { month: MONTH, q: "_" })).toHaveLength(0);
    expect(await listTransactions(appDb, { month: MONTH, q: "sueldo_septiembre" })).toHaveLength(0);
    expect(await listTransactions(appDb, { month: MONTH, q: "sueldo septiembre" })).toHaveLength(1);
  });

  it("paginates: page 2 keeps the offset and the real total", async () => {
    const page = await listTransactionsPage(appDb, { month: MONTH }, 2, 2);
    expect(page).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(page.rows.map((t) => t.date)).toEqual(["2026-09-08", "2026-09-05"]);
  });

  it("clamps a requested page beyond the last one", async () => {
    const page = await listTransactionsPage(appDb, { month: MONTH }, 99, 2);
    expect(page).toMatchObject({ total: 4, page: 2 });
    expect(page.rows).toHaveLength(2);
  });

  it("clamps page 0 up to page 1", async () => {
    const page = await listTransactionsPage(appDb, { month: MONTH }, 0, 2);
    expect(page).toMatchObject({ total: 4, page: 1 });
    expect(page.rows.map((t) => t.date)).toEqual(["2026-09-20", "2026-09-10"]);
  });

  it("returns an empty page 1 when nothing matches", async () => {
    const page = await listTransactionsPage(appDb, { month: MONTH, q: "nada-que-ver" }, 4, 2);
    expect(page).toMatchObject({ total: 0, page: 1 });
    expect(page.rows).toHaveLength(0);
  });

  it("creates an expense (common) with group, parsing AR amounts", async () => {
    const result = await createTransaction(
      appDb,
      mate,
      parseInput({
        date: "2026-08-15",
        amount: "1.234,56",
        groupId: activeGroup.id,
        note: "Almacén",
      }),
    );
    expect(result).toEqual({ ok: true });

    const [row] = await db.select().from(transactions).where(eq(transactions.note, "Almacén"));
    expect(row).toMatchObject({
      date: "2026-08-15",
      amountCents: 123_456,
      type: "expense",
      scope: "common",
      memberId: mateId,
      groupId: activeGroup.id,
    });
  });

  it("creates an income without extras (scope defaults to common, note null)", async () => {
    const result = await createTransaction(
      appDb,
      ana,
      parseInput({
        date: "2026-08-01",
        amount: "50000",
        type: "income",
        categoryId: incomeCat.id,
      }),
    );
    expect(result).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(transactions)
      .where(
        and(eq(transactions.categoryId, incomeCat.id), eq(transactions.date, "2026-08-01")),
      );
    expect(row).toMatchObject({ scope: "common", note: null, groupId: null });
  });

  it("attributes an individual-scope movement to the acting member", async () => {
    const result = await createTransaction(
      appDb,
      mate,
      parseInput({ date: "2026-08-20", scope: "individual" }),
    );
    expect(result).toEqual({ ok: true });
    const rows = await db.select().from(transactions).where(eq(transactions.scope, "individual"));
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe(mateId);
  });

  it("rejects unparseable and non-positive amounts with invalid_amount", async () => {
    expect(
      await createTransaction(appDb, mate, parseInput({ amount: "no-es-numero" })),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(await createTransaction(appDb, mate, parseInput({ amount: "0" }))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
    expect(await createTransaction(appDb, mate, parseInput({ amount: "-5" }))).toEqual({
      ok: false,
      error: "invalid_amount",
    });
  });

  it("rejects a category whose kind does not match the transaction type", async () => {
    expect(
      await createTransaction(
        appDb,
        mate,
        parseInput({ type: "income", categoryId: expenseCat.id }),
      ),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
    expect(
      await createTransaction(
        appDb,
        mate,
        parseInput({ categoryId: incomeCat.id }), // expense type + income category
      ),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
  });

  it("rejects movements targeting a deactivated member", async () => {
    const [inactive] = await db
      .insert(users)
      .values({ username: "baja", name: "Baja", passwordHash: "x", isActive: false })
      .returning();
    expect(
      await createTransaction(
        appDb,
        admin,
        parseInput({ memberId: inactive.id, scope: "individual" }),
      ),
    ).toEqual({ ok: false, error: "member_inactive" });
  });

  it("rejects an ambiguous dot-thousands amount with a typed error", async () => {
    expect(
      await createTransaction(appDb, mate, parseInput({ amount: "1.234" })),
    ).toEqual({ ok: false, error: "ambiguous_amount" });
  });

  it("rejects a closed group for new movements", async () => {
    expect(
      await createTransaction(appDb, mate, parseInput({ groupId: closedGroup.id })),
    ).toEqual({ ok: false, error: "group_closed" });
  });

  it("rejects a member attributing the movement to someone else", async () => {
    expect(
      await createTransaction(appDb, mate, parseInput({ memberId: anaId })),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("reports unknown references with not_found", async () => {
    const ghost = "00000000-0000-4000-8000-000000000001";
    expect(
      await createTransaction(appDb, admin, parseInput({ categoryId: ghost })),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await createTransaction(appDb, admin, parseInput({ groupId: ghost }))).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  describe("update permission matrix (rule 6)", () => {
    it("lets a member update their own transaction", async () => {
      const result = await updateTransaction(
        appDb,
        mate,
        fixtureTx.id,
        parseInput({ amount: "2.500,00", note: "Compra mensual" }),
      );
      expect(result).toEqual({ ok: true });
      const [row] = await db.select().from(transactions).where(eq(transactions.id, fixtureTx.id));
      expect(row).toMatchObject({ amountCents: 250_000, note: "Compra mensual" });
    });

    it("forbids a member updating someone else's transaction", async () => {
      const [anaTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.memberId, anaId))
        .limit(1);
      expect(await updateTransaction(appDb, mate, anaTx.id, parseInput())).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    it("lets an admin update anyone's transaction and retarget the member", async () => {
      const [anaTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.memberId, anaId))
        .limit(1);
      const result = await updateTransaction(
        appDb,
        admin,
        anaTx.id,
        parseInput({ memberId: anaId, amount: "7.000,00" }),
      );
      expect(result).toEqual({ ok: true });
      const [row] = await db.select().from(transactions).where(eq(transactions.id, anaTx.id));
      expect(row.amountCents).toBe(700_000);
    });

    it("reports not_found for a missing transaction", async () => {
      expect(
        await updateTransaction(
          appDb,
          admin,
          "00000000-0000-4000-8000-000000000003",
          parseInput(),
        ),
      ).toEqual({ ok: false, error: "not_found" });
    });
  });

  it("update re-runs the integrity rules (category kind, group)", async () => {
    expect(
      await updateTransaction(
        appDb,
        mate,
        fixtureTx.id,
        parseInput({ categoryId: incomeCat.id }), // expense type + income category
      ),
    ).toEqual({ ok: false, error: "category_kind_mismatch" });
    expect(
      await updateTransaction(
        appDb,
        mate,
        fixtureTx.id,
        parseInput({ groupId: closedGroup.id }),
      ),
    ).toEqual({ ok: false, error: "group_closed" });
  });

  describe("delete permission matrix (rule 6)", () => {
    it("lets a member delete their own transaction", async () => {
      const result = await removeTransaction(appDb, mate, fixtureTx.id);
      expect(result).toEqual({ ok: true });
      const gone = await db.select().from(transactions).where(eq(transactions.id, fixtureTx.id));
      expect(gone).toHaveLength(0);
    });

    it("forbids a member deleting someone else's transaction", async () => {
      const [anaTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.memberId, anaId))
        .limit(1);
      expect(await removeTransaction(appDb, mate, anaTx.id)).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    it("lets an admin delete anyone's transaction", async () => {
      const [anaTx] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.memberId, anaId))
        .limit(1);
      expect(await removeTransaction(appDb, admin, anaTx.id)).toEqual({ ok: true });
    });

    it("reports not_found for a missing transaction", async () => {
      expect(
        await removeTransaction(appDb, admin, "00000000-0000-4000-8000-000000000004"),
      ).toEqual({ ok: false, error: "not_found" });
    });
  });

  describe("quick capture + receipts", () => {
    const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
    const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
    const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

    function imageFile(mime = "image/jpeg", bytes: number[] = JPEG_HEAD): File {
      return new File([new Uint8Array(bytes)], "ticket", { type: mime });
    }

    function quickParse(overrides: Record<string, unknown> = {}) {
      // memberId "" mirrors the action, which always sends the field.
      return quickMovementSchema.parse({
        receipt: imageFile(),
        date: "",
        memberId: "",
        ...overrides,
      });
    }

    it("quick create files a pending movement (0, no category) with its receipt", async () => {
      const totalsBefore = await transactionTotals(appDb, { month: MONTH });
      const result = await createQuickTransaction(appDb, ana, quickParse({ date: "2026-09-15" }));
      expect(result).toEqual({ ok: true });

      const [row] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.memberId, anaId), eq(transactions.needsDetails, true)));
      expect(row).toMatchObject({
        date: "2026-09-15",
        amountCents: 0,
        type: "expense",
        categoryId: null,
        memberId: anaId,
        scope: "common",
        note: PENDING_DETAILS_NOTE,
      });

      const [receipt] = await db
        .select()
        .from(movementReceipts)
        .where(eq(movementReceipts.transactionId, row.id));
      expect(receipt.mimeType).toBe("image/jpeg");
      expect(Array.from(receipt.bytes as Uint8Array)).toEqual(JPEG_HEAD);

      // Totals unchanged: pending rows are placeholders, not money...
      expect(await transactionTotals(appDb, { month: MONTH })).toEqual(totalsBefore);

      // ...but the list keeps them visible so they can be completed.
      const listed = await listTransactions(appDb, { month: MONTH });
      expect(listed.find((t) => t.id === row.id)).toMatchObject({
        needsDetails: true,
        receiptId: receipt.id,
        categoryId: null,
        categoryName: null,
      });
    });

    it("completing a pending movement counts it in totals again", async () => {
      // A pending row WITH a positive amount must still stay out of totals.
      const [pending] = await db
        .insert(transactions)
        .values({
          date: "2026-09-18",
          amountCents: 5_000,
          type: "expense",
          memberId: mateId,
          needsDetails: true,
          note: PENDING_DETAILS_NOTE,
        })
        .returning();
      const totalsPending = await transactionTotals(appDb, { month: MONTH });

      const result = await updateTransaction(
        appDb,
        admin,
        pending.id,
        parseInput({ date: "2026-09-18", amount: "5.000,00", memberId: mateId }),
      );
      expect(result).toEqual({ ok: true });

      const [row] = await db.select().from(transactions).where(eq(transactions.id, pending.id));
      expect(row).toMatchObject({
        needsDetails: false,
        amountCents: 500_000,
        categoryId: expenseCat.id,
        note: null, // the pending annotation is cleared on completion
      });

      const totalsCompleted = await transactionTotals(appDb, { month: MONTH });
      expect(totalsCompleted.expenseCents).toBe(totalsPending.expenseCents + 500_000);
      expect(totalsCompleted.incomeCents).toBe(totalsPending.incomeCents);
    });

    it("getReceiptFile returns it to the owner, hides it from other members, admins override", async () => {
      // Ana's quick-capture receipt from the first test of this block.
      const [row] = await db
        .select({ id: movementReceipts.id })
        .from(movementReceipts)
        .innerJoin(transactions, eq(movementReceipts.transactionId, transactions.id))
        .where(eq(transactions.memberId, anaId))
        .limit(1);

      const own = await getReceiptFile(appDb, ana, row.id);
      expect(own).not.toBeNull();
      expect(own?.mimeType).toBe("image/jpeg");
      expect(Array.from(own?.bytes ?? [])).toEqual(JPEG_HEAD);

      // Foreign member: same answer as a missing receipt (existence never leaks).
      expect(await getReceiptFile(appDb, mate, row.id)).toBeNull();

      // Admin override + unknown id.
      const adminCopy = await getReceiptFile(appDb, admin, row.id);
      expect(adminCopy?.mimeType).toBe("image/jpeg");
      expect(await getReceiptFile(appDb, admin, GHOST)).toBeNull();
    });

    it("rejects oversized, wrong-typed and fake-byte receipts with typed errors", async () => {
      const oversize = new File([new Uint8Array(RECEIPT_MAX_BYTES + 1)], "big.jpg", {
        type: "image/jpeg",
      });
      expect(
        await createQuickTransaction(appDb, mate, quickParse({ receipt: oversize })),
      ).toEqual({ ok: false, error: "receipt_too_large" });

      // Declared GIF → outside the allow-list.
      expect(
        await createQuickTransaction(appDb, mate, quickParse({ receipt: imageFile("image/gif") })),
      ).toEqual({ ok: false, error: "receipt_invalid_type" });

      // Declared JPEG but wrong magic bytes → sniffed and rejected.
      const fake = imageFile("image/jpeg", [0x00, 0x11, 0x22, 0x33, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(
        await createQuickTransaction(appDb, mate, quickParse({ receipt: fake })),
      ).toEqual({ ok: false, error: "receipt_invalid_type" });
    });

    it("quick schema demands a real image file", () => {
      expect(quickMovementSchema.safeParse({ date: "" }).success).toBe(false);
      expect(
        quickMovementSchema.safeParse({
          date: "",
          receipt: new File([], "empty.jpg", { type: "image/jpeg" }),
        }).success,
      ).toBe(false);
    });

    it("full movements attach an optional receipt; update replaces it", async () => {
      const createResult = await createTransaction(
        appDb,
        mate,
        parseInput({
          date: "2026-08-25",
          amount: "900",
          receipt: imageFile("image/png", PNG_HEAD),
        }),
      );
      expect(createResult).toEqual({ ok: true });
      const [created] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.memberId, mateId), eq(transactions.date, "2026-08-25")));
      expect(created.needsDetails).toBe(false);
      const [receipt] = await db
        .select()
        .from(movementReceipts)
        .where(eq(movementReceipts.transactionId, created.id));
      expect(receipt.mimeType).toBe("image/png");

      // Replacing on edit: still exactly one receipt, now a WebP.
      expect(
        await updateTransaction(
          appDb,
          mate,
          created.id,
          parseInput({ date: "2026-08-25", amount: "900", receipt: imageFile("image/webp", WEBP_HEAD) }),
        ),
      ).toEqual({ ok: true });
      const receipts = await db
        .select()
        .from(movementReceipts)
        .where(eq(movementReceipts.transactionId, created.id));
      expect(receipts).toHaveLength(1);
      expect(receipts[0].mimeType).toBe("image/webp");

      // Updating WITHOUT a receipt leaves the stored one untouched.
      expect(
        await updateTransaction(
          appDb,
          mate,
          created.id,
          parseInput({ date: "2026-08-25", amount: "1.000,00" }),
        ),
      ).toEqual({ ok: true });
      expect(
        await db.select().from(movementReceipts).where(eq(movementReceipts.transactionId, created.id)),
      ).toHaveLength(1);
    });
  });

  describe("input schema (trust boundary)", () => {
    it("rejects malformed dates, ids and over-long notes", () => {
      expect(movementSchema.safeParse({ ...rawInput(), date: "17/09/2026" }).success).toBe(false);
      expect(movementSchema.safeParse({ ...rawInput(), categoryId: "no-uuid" }).success).toBe(
        false,
      );
      expect(movementSchema.safeParse({ ...rawInput(), note: "x".repeat(201) }).success).toBe(
        false,
      );
    });

    it("accepts future dates and defaults an empty date to today", () => {
      expect(movementSchema.parse({ ...rawInput(), date: "2027-01-31" }).date).toBe("2027-01-31");
      expect(movementSchema.parse({ ...rawInput(), date: "" }).date).toBe(todayIso());
    });
  });
});

/**
 * Pure clock tests (no DB): 'today' must follow the app timezone
 * (America/Argentina/Buenos_Aires), never the server's local TZ — a UTC
 * server would otherwise file no-JS submissions under the wrong day around
 * midnight (00:00-03:00 AR time).
 */
describe("todayIso (app timezone)", () => {
  it("formats the calendar day in America/Argentina/Buenos_Aires as YYYY-MM-DD", () => {
    // 2026-09-22 01:59 UTC is still 2026-09-21 in Buenos Aires (UTC-3).
    expect(todayIso(new Date("2026-09-22T01:59:00Z"))).toBe("2026-09-21");
    // 03:00 UTC is already 2026-09-22 there.
    expect(todayIso(new Date("2026-09-22T03:00:00Z"))).toBe("2026-09-22");
  });
});

describe("card purchases (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let mate: SessionUser;
  let expenseCat: { id: string };
  let incomeCat: { id: string };
  let cardId: string;
  let plainLoanId: string;
  let inactiveCardId: string;

  const MONTH = "2026-09";

  function cardInput(overrides: Record<string, unknown> = {}) {
    return movementSchema.parse({
      date: "2026-09-10",
      amount: "300,00",
      type: "expense",
      categoryId: expenseCat.id,
      memberId: "",
      groupId: "",
      scope: "common",
      note: "",
      paymentMethod: "card",
      cardId,
      ...overrides,
    });
  }

  /** Cupo disponible reported by the loans side (single source of truth). */
  async function availableCents(): Promise<number> {
    const { listLoans } = await import("@/features/loans/service");
    const card = (await listLoans(appDb)).find((loan) => loan.id === cardId)!;
    return card.availableCents!;
  }

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "cadmin", name: "CAdmin", passwordHash: "x", role: "admin" })
      .returning();
    const [mateRow] = await db
      .insert(users)
      .values({ username: "cmate", name: "CMate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    mate = { id: mateRow.id, username: mateRow.username, name: mateRow.name, role: mateRow.role };
    [expenseCat] = await db
      .insert(categories)
      .values({ name: "CSuper", kind: "expense" })
      .returning();
    [incomeCat] = await db
      .insert(categories)
      .values({ name: "CSueldo", kind: "income" })
      .returning();

    const { createLoan, toggleLoanActive } = await import("@/features/loans/service");
    const emptyEngine = {
      chargedRate: "",
      contractualRate: "",
      termMonths: "",
      fixedCuota: "",
      cuotaDay: "",
      propertyValue: "",
      insuredBase: "",
      lifeRatePerMillon: "",
      fireRatePerMillon: "",
      moraRate: "",
      otherCharges: "",
    } as const;
    const revolving = {
      name: "Visa Compra",
      kind: "credit_card" as const,
      entity: "Banco Nación",
      scope: "common" as const,
      memberId: "",
      principal: "0,00",
      annualRate: "",
      amortizationMode: "revolving" as const,
      ...emptyEngine,
      creditLimit: "1.000,00",
      managementFee: "",
      statementDay: "",
    };
    expect(await createLoan(appDb, admin, revolving)).toEqual({ ok: true });
    const { loans } = await import("@/db/schema");
    [cardId] = (
      await db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Visa Compra"))
    ).map((r) => r.id);

    expect(
      await createLoan(appDb, admin, {
        ...revolving,
        name: "Préstamo simple",
        kind: "other",
        amortizationMode: "" as unknown as "",
        principal: "500,00",
        creditLimit: "",
        managementFee: "",
        statementDay: "",
      }),
    ).toEqual({ ok: true });
    [plainLoanId] = (
      await db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Préstamo simple"))
    ).map((r) => r.id);

    expect(
      await createLoan(appDb, admin, { ...revolving, name: "Visa Vieja" }),
    ).toEqual({ ok: true });
    const [inactiveCard] = (
      await db.select({ id: loans.id }).from(loans).where(eq(loans.name, "Visa Vieja"))
    ).map((r) => r.id);
    await toggleLoanActive(appDb, admin, inactiveCard);
    inactiveCardId = inactiveCard;
  });

  afterAll(async () => {
    await client.close();
  });

  it("keeps method/card coherence at the zod level", async () => {
    const raw = {
      date: "2026-09-10",
      amount: "300,00",
      type: "expense",
      categoryId: expenseCat.id,
      memberId: "",
      groupId: "",
      scope: "common",
      note: "",
      cardId,
    };
    // Card without card id…
    expect(movementSchema.safeParse({ ...raw, paymentMethod: "card", cardId: "" }).success).toBe(
      false,
    );
    // …and card id on a cash movement.
    expect(movementSchema.safeParse({ ...raw, paymentMethod: "cash" }).success).toBe(false);
  });

  it("creates a card purchase, consumes cupo and exposes the card name", async () => {
    expect(await createTransaction(appDb, mate, cardInput())).toEqual({ ok: true });
    expect(await availableCents()).toBe(70_000); // 100.000 − 30.000

    const rows = await listTransactions(appDb, { month: MONTH, paymentMethod: "card" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentMethod: "card",
      cardId,
      cardName: "Visa Compra",
      amountCents: 30_000,
    });
    const cashRows = await listTransactions(appDb, { month: MONTH, paymentMethod: "cash" });
    expect(cashRows).toHaveLength(0);
  });

  it("blocks purchases beyond the cupo with a typed error", async () => {
    expect(
      await createTransaction(appDb, mate, cardInput({ amount: "80.000,00" })),
    ).toEqual({ ok: false, error: "card_limit_exceeded" });
  });

  it("rejects invalid card targets with typed errors", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(await createTransaction(appDb, mate, cardInput({ cardId: ghost }))).toEqual({
      ok: false,
      error: "card_not_found",
    });
    expect(
      await createTransaction(appDb, mate, cardInput({ cardId: plainLoanId })),
    ).toEqual({ ok: false, error: "card_not_revolving" });
    expect(
      await createTransaction(appDb, mate, cardInput({ cardId: inactiveCardId })),
    ).toEqual({ ok: false, error: "card_inactive" });
  });

  it("only expenses may ride a card (service mirror of the DB CHECK)", async () => {
    expect(
      await createTransaction(
        appDb,
        mate,
        cardInput({ type: "income", categoryId: incomeCat.id }),
      ),
    ).toEqual({ ok: false, error: "card_requires_expense" });
  });

  it("edit validates the cupo DELTA on the same card, full amount on a switch", async () => {
    const [purchase] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.cardLoanId, cardId))
      .limit(1);

    // Delta +20.000 over a 70.000 available cupo: fits.
    expect(
      await updateTransaction(appDb, mate, purchase.id, cardInput({ amount: "500,00" })),
    ).toEqual({ ok: true });
    expect(await availableCents()).toBe(50_000);

    // Delta +70.000 over 50.000 available: blocked.
    expect(
      await updateTransaction(appDb, mate, purchase.id, cardInput({ amount: "1.200,00" })),
    ).toEqual({ ok: false, error: "card_limit_exceeded" });

    // Reducing frees cupo immediately (recomputed, never stored).
    expect(
      await updateTransaction(appDb, mate, purchase.id, cardInput({ amount: "200,00" })),
    ).toEqual({ ok: true });
    expect(await availableCents()).toBe(80_000);

    // Switching to cash releases the whole purchase from the card.
    expect(
      await updateTransaction(
        appDb,
        mate,
        purchase.id,
        cardInput({ amount: "200,00", paymentMethod: "cash", cardId: "" }),
      ),
    ).toEqual({ ok: true });
    expect(await availableCents()).toBe(100_000);
  });

  it("completes a pending quick-capture as a card purchase inside the cupo", async () => {
    const { createQuickTransaction } = await import("@/features/transactions/service");
    const receipt = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "r.png", {
      type: "image/png",
    });
    expect(
      await createQuickTransaction(appDb, mate, {
        date: "2026-09-15",
        memberId: "",
        type: "expense",
        receipt: receipt as unknown as globalThis.File,
      }),
    ).toEqual({ ok: true });
    const [pending] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.needsDetails, true))
      .limit(1);

    // Completing with a card over the cupo: blocked like any create.
    expect(
      await updateTransaction(
        appDb,
        mate,
        pending.id,
        cardInput({ amount: "999.999,00", date: "2026-09-15" }),
      ),
    ).toEqual({ ok: false, error: "card_limit_exceeded" });
    expect(
      await updateTransaction(appDb, mate, pending.id, cardInput({ date: "2026-09-15" })),
    ).toEqual({ ok: true });
    expect(await availableCents()).toBe(70_000);
  });
});

describe("setOpeningBalance (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let mate: SessionUser;
  // Fixed clock: the not-future date boundary never depends on the real today.
  const NOW = new Date("2026-09-20T12:00:00Z");

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [adminRow] = await db
      .insert(users)
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    const [mateRow] = await db
      .insert(users)
      .values({ username: "mate", name: "Mate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: adminRow.id, username: adminRow.username, name: adminRow.name, role: adminRow.role };
    mate = { id: mateRow.id, username: mateRow.username, name: mateRow.name, role: mateRow.role };
  });

  afterAll(async () => {
    await client.close();
  });

  it("rejects a member with forbidden", async () => {
    expect(
      await setOpeningBalance(appDb, mate, { amount: "100", date: "2026-08-15" }, NOW),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("reports system_category_missing when the seed has not run", async () => {
    expect(
      await setOpeningBalance(appDb, admin, { amount: "100", date: "2026-08-15" }, NOW),
    ).toEqual({ ok: false, error: "system_category_missing" });

    // The rest of the suite runs against the seeded system category.
    await db.insert(categories).values({ name: "Saldo inicial", kind: "income" });
  });

  it("creates a positive adjustment: income of its month, anchors next month's arrastre", async () => {
    const result = await setOpeningBalance(
      appDb,
      admin,
      { amount: "$ 50.000,00", date: "2026-08-15" },
      NOW,
    );
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-08-15",
      amountCents: 5_000_000,
      type: "income",
      memberId: admin.id,
      scope: "common",
      paymentMethod: "cash",
      note: "Saldo inicial",
      needsDetails: false,
    });

    // No special-casing: it IS a movement of its month...
    expect(await transactionTotals(appDb, { month: "2026-08" })).toMatchObject({
      incomeCents: 5_000_000,
    });
    // ...and the arrastre of the NEXT month starts at the real money.
    expect(await openingBalanceCents(appDb, { month: "2026-09" })).toBe(5_000_000);
    expect(await findOpeningBalance(appDb)).toEqual({ date: "2026-08-15", signedCents: 5_000_000 });
  });

  it("upserts on sign change: updates amount + date and flips type, one row total", async () => {
    const result = await setOpeningBalance(
      appDb,
      admin,
      { amount: "-30.000,00", date: "2026-08-10" },
      NOW,
    );
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-08-10",
      amountCents: 3_000_000,
      type: "expense",
      memberId: admin.id,
    });

    // Flipped to an expense of its month; the arrastre goes negative.
    expect(await transactionTotals(appDb, { month: "2026-08" })).toMatchObject({
      incomeCents: 0,
      expenseCents: 3_000_000,
    });
    expect(await openingBalanceCents(appDb, { month: "2026-09" })).toBe(-3_000_000);
    expect(await findOpeningBalance(appDb)).toEqual({ date: "2026-08-10", signedCents: -3_000_000 });
  });

  it("inserts a fresh negative adjustment when no row exists", async () => {
    await db.delete(transactions);
    const result = await setOpeningBalance(
      appDb,
      admin,
      { amount: "-$ 30.000,00", date: "2026-07-31" },
      NOW,
    );
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(transactions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-07-31",
      amountCents: 3_000_000,
      type: "expense",
      paymentMethod: "cash",
    });
    expect(await openingBalanceCents(appDb, { month: "2026-09" })).toBe(-3_000_000);
  });

  it("rejects a future date against the injected clock (today passes)", async () => {
    expect(
      await setOpeningBalance(appDb, admin, { amount: "100", date: "2026-09-21" }, NOW),
    ).toEqual({ ok: false, error: "future_date" });
    expect(
      await setOpeningBalance(appDb, admin, { amount: "100", date: "2026-09-20" }, NOW),
    ).toEqual({ ok: true });
  });

  it("rejects invalid, zero and ambiguous amounts", async () => {
    expect(
      await setOpeningBalance(appDb, admin, { amount: "no-es-numero", date: "2026-08-15" }, NOW),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(
      await setOpeningBalance(appDb, admin, { amount: "0", date: "2026-08-15" }, NOW),
    ).toEqual({ ok: false, error: "invalid_amount" });
    expect(
      await setOpeningBalance(appDb, admin, { amount: "1.234", date: "2026-08-15" }, NOW),
    ).toEqual({ ok: false, error: "ambiguous_amount" });
  });

  it("openingBalanceSchema rejects a malformed date and an empty amount", () => {
    expect(openingBalanceSchema.safeParse({ date: "20/09/2026", amount: "1" }).success).toBe(false);
    expect(openingBalanceSchema.safeParse({ date: "2026-09-20", amount: "" }).success).toBe(false);
  });
});
