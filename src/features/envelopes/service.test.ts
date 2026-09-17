import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { categories, envelopes, transactions, users } from "@/db/schema";
import {
  envelopeSchema,
  createEnvelope,
  listEnvelopes,
  removeEnvelope,
  toggleEnvelopeActive,
  updateEnvelope,
  type EnvelopeInput,
} from "@/features/envelopes/service";
import type { SessionUser } from "@/lib/auth";

/**
 * Envelopes service suite: scope validation mirroring the CHECK constraint,
 * AR-formatted amount parsing, admin-only authorization and the FK-protected
 * delete — against in-memory Postgres with the real migrations.
 */
describe("envelopes service (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: SessionUser;
  let member: SessionUser;
  let memberId: string;

  const commonInput: EnvelopeInput = {
    name: "Mercado",
    scope: "common",
    memberId: "",
    monthlyAmount: "1500",
  };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [row] = await db
      .insert(users)
      .values({ username: "admin", name: "Admin", passwordHash: "x", role: "admin" })
      .returning();
    const [mate] = await db
      .insert(users)
      .values({ username: "mate", name: "Mate", passwordHash: "x", role: "member" })
      .returning();
    admin = { id: row.id, username: row.username, name: row.name, role: row.role };
    member = { id: mate.id, username: mate.username, name: mate.name, role: mate.role };
    memberId = mate.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates a common envelope without member and an individual one with member", async () => {
    expect(await createEnvelope(appDb, admin, commonInput)).toEqual({ ok: true });
    expect(
      await createEnvelope(appDb, admin, {
        name: "Gastos de Ana",
        scope: "individual",
        memberId,
        monthlyAmount: "50000",
      }),
    ).toEqual({ ok: true });

    const listed = await listEnvelopes(appDb);
    // Common sorts first, then individual.
    expect(listed.map((e) => e.name)).toEqual(["Mercado", "Gastos de Ana"]);
    const individual = listed.find((e) => e.scope === "individual");
    expect(individual).toMatchObject({ memberName: "Mate", monthlyAmountCents: 5_000_000 });
  });

  it("rejects an individual envelope without member (zod, mirrors CHECK)", async () => {
    const parsed = envelopeSchema.safeParse({ ...commonInput, scope: "individual" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const fieldError = parsed.error.issues.find((i) => i.path[0] === "memberId");
    expect(fieldError?.message).toBe("Las bolsas individuales requieren un integrante.");
  });

  it("rejects a common envelope with member (zod, mirrors CHECK)", async () => {
    const parsed = envelopeSchema.safeParse({ ...commonInput, memberId });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const fieldError = parsed.error.issues.find((i) => i.path[0] === "memberId");
    expect(fieldError?.message).toBe("Las bolsas comunes no llevan integrante.");
  });

  it("updates name, scope, member and amount parsed from an AR-formatted string", async () => {
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "Mercado"));

    const result = await updateEnvelope(appDb, admin, row.id, {
      name: "Mercado común",
      scope: "individual",
      memberId,
      monthlyAmount: "1.234,56",
    });

    expect(result).toEqual({ ok: true });
    const [after] = await db.select().from(envelopes).where(eq(envelopes.id, row.id));
    expect(after).toMatchObject({
      name: "Mercado común",
      scope: "individual",
      memberId,
      monthlyAmountCents: 123_456,
    });
  });

  it("reports a typed error for an unparseable amount", async () => {
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "Mercado común"));
    const result = await updateEnvelope(appDb, admin, row.id, {
      ...commonInput,
      name: "Mercado común",
      scope: "individual",
      memberId,
      monthlyAmount: "no-es-un-numero",
    });
    expect(result).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("reports a typed error for unknown ids", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    expect(await updateEnvelope(appDb, admin, ghostId, commonInput)).toEqual({
      ok: false,
      error: "envelope_not_found",
    });
    expect(await toggleEnvelopeActive(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "envelope_not_found",
    });
    expect(await removeEnvelope(appDb, admin, ghostId)).toEqual({
      ok: false,
      error: "envelope_not_found",
    });
  });

  it("toggles active state", async () => {
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "Mercado común"));

    expect(await toggleEnvelopeActive(appDb, admin, row.id)).toEqual({ ok: true });
    let after = await db.select().from(envelopes).where(eq(envelopes.id, row.id));
    expect(after[0].isActive).toBe(false);

    expect(await toggleEnvelopeActive(appDb, admin, row.id)).toEqual({ ok: true });
    after = await db.select().from(envelopes).where(eq(envelopes.id, row.id));
    expect(after[0].isActive).toBe(true);
  });

  it("deleting an envelope with movements fails with a typed restrict error", async () => {
    await createEnvelope(appDb, admin, { ...commonInput, name: "ConMovs" });
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "ConMovs"));
    const [category] = await db
      .insert(categories)
      .values({ name: "Env Cat", kind: "expense" })
      .returning();
    await db.insert(transactions).values({
      amountCents: 100,
      type: "expense",
      categoryId: category.id,
      memberId,
      envelopeId: row.id,
    });

    const result = await removeEnvelope(appDb, admin, row.id);

    expect(result).toEqual({ ok: false, error: "has_movements" });
    const stillThere = await db.select().from(envelopes).where(eq(envelopes.id, row.id));
    expect(stillThere).toHaveLength(1);
  });

  it("deleting an envelope without movements succeeds", async () => {
    await createEnvelope(appDb, admin, { ...commonInput, name: "Limpia" });
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "Limpia"));

    expect(await removeEnvelope(appDb, admin, row.id)).toEqual({ ok: true });
    const gone = await db.select().from(envelopes).where(eq(envelopes.id, row.id));
    expect(gone).toHaveLength(0);
  });

  it("enforces admin-only authorization at service level", async () => {
    const [row] = await db.select().from(envelopes).where(eq(envelopes.name, "Mercado común"));
    expect(await createEnvelope(appDb, member, commonInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await updateEnvelope(appDb, member, row.id, commonInput)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await toggleEnvelopeActive(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await removeEnvelope(appDb, member, row.id)).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  describe("input schema (trust boundary)", () => {
    it("rejects invalid member ids and empty amounts", () => {
      const base = { name: "X", scope: "individual" as const, monthlyAmount: "100" };
      expect(envelopeSchema.safeParse({ ...base, memberId: "no-uuid" }).success).toBe(false);
      expect(envelopeSchema.safeParse({ ...base, memberId: "" }).success).toBe(false);
      expect(
        envelopeSchema.safeParse({ ...base, memberId, monthlyAmount: "" }).success,
      ).toBe(false);
    });
  });
});
