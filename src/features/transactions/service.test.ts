import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import {
  categories,
  envelopes,
  expenseGroups,
  transactions,
  users,
} from "@/db/schema";
import {
  movementSchema,
  createTransaction,
  getTransaction,
  listTransactions,
  removeTransaction,
  todayIso,
  transactionTotals,
  updateTransaction,
} from "@/features/transactions/service";
import type { MovementInput } from "@/features/transactions/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Transactions service suite: integrity rules 1-7 (category kind, envelope
 * activity/ownership, group status, AR amount parsing, member ownership for
 * edit/delete), filters, exact-cent totals — against in-memory Postgres with
 * the real migrations.
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
  let commonEnvelope: { id: string };
  let anaEnvelope: { id: string };
  let inactiveEnvelope: { id: string };
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
      envelopeId: "",
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

    [commonEnvelope, anaEnvelope, inactiveEnvelope] = await db
      .insert(envelopes)
      .values([
        { name: "Mercado", scope: "common" },
        { name: "Gastos de Ana", scope: "individual", memberId: anaId },
        { name: "Vieja", scope: "common", isActive: false },
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
          envelopeId: commonEnvelope.id,
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
    expect(month.map((t) => t.date)).toEqual(["2026-09-20", "2026-09-10", "2026-09-05"]);

    const byCategory = await listTransactions(appDb, { categoryId: expenseCat.id });
    expect(byCategory.map((t) => t.date)).toEqual(["2026-10-01", "2026-09-10", "2026-09-05"]);

    const byMember = await listTransactions(appDb, { memberId: mateId });
    expect(byMember.map((t) => t.date)).toEqual(["2026-10-01", "2026-09-20", "2026-09-10"]);

    const byEnvelope = await listTransactions(appDb, { envelopeId: commonEnvelope.id });
    expect(byEnvelope.map((t) => t.date)).toEqual(["2026-09-10"]);

    const byActiveGroup = await listTransactions(appDb, { groupId: activeGroup.id });
    expect(byActiveGroup.map((t) => t.date)).toEqual(["2026-09-10"]);

    const byClosedGroup = await listTransactions(appDb, { groupId: closedGroup.id });
    expect(byClosedGroup.map((t) => t.date)).toEqual(["2026-09-05"]);

    const byType = await listTransactions(appDb, { type: "income" });
    expect(byType.map((t) => t.date)).toEqual(["2026-09-20"]);
  });

  it("lists with combined filters and joins display names", async () => {
    const rows = await listTransactions(appDb, { month: MONTH, memberId: mateId, type: "expense" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      categoryName: "Super",
      categoryColor: "#16a34a",
      memberName: "Mate",
      envelopeName: "Mercado",
      groupName: "Vacaciones",
      amountCents: 25_000,
    });
  });

  it("computes exact-cent totals for the filtered set", async () => {
    expect(await transactionTotals(appDb, { month: MONTH })).toEqual({
      incomeCents: 100_000,
      expenseCents: 30_500,
      balanceCents: 69_500,
    });
    expect(await transactionTotals(appDb, { month: MONTH, type: "income" })).toEqual({
      incomeCents: 100_000,
      expenseCents: 0,
      balanceCents: 100_000,
    });
    expect(await transactionTotals(appDb, { month: MONTH, memberId: anaId })).toEqual({
      incomeCents: 0,
      expenseCents: 5_500,
      balanceCents: -5_500,
    });
  });

  it("gets one transaction with joined names, or null", async () => {
    const view = await getTransaction(appDb, fixtureTx.id);
    expect(view).toMatchObject({ memberName: "Mate", categoryName: "Super" });
    expect(await getTransaction(appDb, GHOST)).toBeNull();
  });

  it("creates an expense (common) with envelope and group, parsing AR amounts", async () => {
    const result = await createTransaction(
      appDb,
      mate,
      parseInput({
        date: "2026-08-15",
        amount: "1.234,56",
        envelopeId: commonEnvelope.id,
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
      envelopeId: commonEnvelope.id,
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
    expect(row).toMatchObject({ scope: "common", note: null, envelopeId: null, groupId: null });
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

  it("rejects an inactive envelope and an individual envelope of another member", async () => {
    expect(
      await createTransaction(
        appDb,
        mate,
        parseInput({ envelopeId: inactiveEnvelope.id }),
      ),
    ).toEqual({ ok: false, error: "envelope_inactive" });
    expect(
      await createTransaction(
        appDb,
        mate,
        parseInput({ envelopeId: anaEnvelope.id }),
      ),
    ).toEqual({ ok: false, error: "envelope_member_mismatch" });
    // Ana CAN use her own individual envelope.
    expect(
      await createTransaction(
        appDb,
        ana,
        parseInput({ date: "2026-08-21", envelopeId: anaEnvelope.id }),
      ),
    ).toEqual({ ok: true });
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
    expect(
      await createTransaction(appDb, admin, parseInput({ envelopeId: ghost })),
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
        parseInput({ amount: "2.500", note: "Compra mensual" }),
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
        parseInput({ memberId: anaId, amount: "7.000" }),
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

  it("update re-runs the integrity rules (category kind, envelope, group)", async () => {
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
        parseInput({ envelopeId: inactiveEnvelope.id }),
      ),
    ).toEqual({ ok: false, error: "envelope_inactive" });
    expect(
      await updateTransaction(
        appDb,
        mate,
        fixtureTx.id,
        parseInput({ groupId: closedGroup.id }),
      ),
    ).toEqual({ ok: false, error: "group_closed" });
    expect(
      await updateTransaction(
        appDb,
        mate,
        fixtureTx.id,
        parseInput({ envelopeId: anaEnvelope.id }),
      ),
    ).toEqual({ ok: false, error: "envelope_member_mismatch" });
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
