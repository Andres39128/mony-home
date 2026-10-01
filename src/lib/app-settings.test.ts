import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createTestDb } from "@/db/test-utils";
import type { Database } from "@/db";
import { appConfig, users } from "@/db/schema";
import { DEFAULT_APP_SETTINGS, getAppSettings, setAppSettings, upsertAppConfig } from "@/lib/app-settings";

/**
 * App settings suite: code-level fallbacks before/without seed data, the
 * admin-only write gate, validation at the trust boundary and the upsert
 * (one row per key, updated_at refreshed) — on in-memory Postgres.
 */
describe("app settings (integration on PGlite)", () => {
  let db: PgliteDatabase;
  let appDb: Database;
  let client: PGlite;
  let admin: { id: string; username: string; name: string; role: "admin" | "member" };
  let member: { id: string; username: string; name: string; role: "admin" | "member" };

  beforeAll(async () => {
    ({ db, client } = await createTestDb());
    appDb = db as unknown as Database;
    const [adminRow] = await db
      .insert(users)
      .values({ username: "root", name: "Root", passwordHash: "x", role: "admin" })
      .returning();
    const [memberRow] = await db
      .insert(users)
      .values({ username: "ana", name: "Ana", passwordHash: "x" })
      .returning();
    admin = { ...adminRow, role: adminRow.role };
    member = { ...memberRow, role: memberRow.role };
  });

  afterAll(async () => {
    await client.close();
  });

  it("falls back to the code defaults when the table is empty or missing", async () => {
    expect(await getAppSettings(appDb)).toEqual(DEFAULT_APP_SETTINGS);

    // Missing table (pre-migration deploy): defaults, never a crashed render.
    await db.execute(`drop table app_config`);
    expect(await getAppSettings(appDb)).toEqual(DEFAULT_APP_SETTINGS);
    await db.execute(
      `create table app_config ("key" text primary key, "value" text not null, "updated_at" timestamptz not null default now())`,
    );
  });

  it("reads the seeded values and falls back per field for invalid ones", async () => {
    await db.insert(appConfig).values([
      { key: "currencyCode", value: "ARS" },
      { key: "locale", value: "es-AR" },
    ]);
    expect(await getAppSettings(appDb)).toEqual({ currencyCode: "ARS", locale: "es-AR" });

    // A hand-edited garbage value degrades to the default, not a crash.
    await db.execute(`update app_config set value = 'pesos' where key = 'currencyCode'`);
    expect(await getAppSettings(appDb)).toEqual({ currencyCode: "COP", locale: "es-AR" });
    await db.execute(`delete from app_config`);
  });

  it("rejects writes from non-admins with 'forbidden'", async () => {
    expect(await setAppSettings(appDb, member, { currencyCode: "COP", locale: "es-CO" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await db.select().from(appConfig)).toHaveLength(0);
  });

  it("validates both fields before touching the table", async () => {
    for (const bad of [
      { currencyCode: "cop", locale: "es-CO" }, // lowercase code
      { currencyCode: "COPP", locale: "es-CO" }, // 4 letters
      { currencyCode: "COP", locale: "es_co" }, // bad locale shape
      { currencyCode: "COP", locale: "es-CO-x" }, // extra subtag
    ]) {
      expect(await setAppSettings(appDb, admin, bad)).toEqual({
        ok: false,
        error: "invalid_input",
      });
    }
    expect(await db.select().from(appConfig)).toHaveLength(0);
  });

  it("upserts both keys and refreshes updated_at on every write", async () => {
    expect(await setAppSettings(appDb, admin, { currencyCode: "COP", locale: "es-CO" })).toEqual({
      ok: true,
    });
    const [first] = await db.select().from(appConfig).where(eq(appConfig.key, "currencyCode"));
    expect(first.value).toBe("COP");

    // Small tick so the refreshed updated_at is observably newer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await upsertAppConfig(appDb, { currencyCode: "EUR", locale: "es-ES" });

    const rows = await db.select().from(appConfig);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === "currencyCode")?.value).toBe("EUR");
    expect(rows.find((r) => r.key === "locale")?.value).toBe("es-ES");
    const after = rows.find((r) => r.key === "currencyCode");
    expect(after!.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });
});
