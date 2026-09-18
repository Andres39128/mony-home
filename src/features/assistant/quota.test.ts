import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { users } from "@/db/schema";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ ASSISTANT_DAILY_LIMIT: 2 }),
}));

const { assertQuota, getQuota, registerUse, usedOn } = await import(
  "@/features/assistant/quota"
);

/**
 * Quota suite: the daily counter gates the OpenRouter free tier. Uses a
 * lowered limit (2) and an injected day to prove per-user isolation and day
 * rollover without touching the clock.
 */
describe("assistant quota (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let userA: string;
  let userB: string;
  const DAY = "2026-09-15";
  const NEXT_DAY = "2026-09-16";

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const rows = await db
      .insert(users)
      .values([
        { username: "ana", name: "Ana", passwordHash: "x" },
        { username: "beto", name: "Beto", passwordHash: "x" },
      ])
      .returning();
    userA = rows[0].id;
    userB = rows[1].id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("starts with the full daily allowance", async () => {
    expect(await getQuota(appDb, userA, DAY)).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
    });
    expect(await assertQuota(appDb, userA, DAY)).toEqual({ ok: true });
  });

  it("registers uses atomically and reports the running count", async () => {
    expect(await registerUse(appDb, userA, DAY)).toBe(1);
    expect(await registerUse(appDb, userA, DAY)).toBe(2);
    expect(await usedOn(appDb, userA, DAY)).toBe(2);
  });

  it("rejects with quota_exceeded once the limit is reached", async () => {
    expect(await assertQuota(appDb, userA, DAY)).toEqual({
      ok: false,
      error: "quota_exceeded",
    });
    expect(await getQuota(appDb, userA, DAY)).toEqual({
      limit: 2,
      used: 2,
      remaining: 0,
    });
  });

  it("isolates users: another member keeps their full allowance", async () => {
    expect(await assertQuota(appDb, userB, DAY)).toEqual({ ok: true });
    expect(await getQuota(appDb, userB, DAY)).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
    });
  });

  it("resets on day rollover (injected day)", async () => {
    expect(await assertQuota(appDb, userA, NEXT_DAY)).toEqual({ ok: true });
    expect(await getQuota(appDb, userA, NEXT_DAY)).toEqual({
      limit: 2,
      used: 0,
      remaining: 2,
    });
    // The exhausted day keeps its own count.
    expect(await usedOn(appDb, userA, DAY)).toBe(2);
  });
});
