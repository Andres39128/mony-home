/**
 * Assistant daily quota — per-user, per-day request counter.
 *
 * The quota protects the OpenRouter FREE tier (50 req/day without credits)
 * from being exhausted by a single household member. Stored in Postgres and
 * incremented with an atomic upsert on the (user_id, day) unique key, so
 * concurrent requests can never overcount or undercount.
 *
 * `day` ('YYYY-MM-DD') is injectable so tests can exercise day rollover
 * without faking the clock.
 */
import { and, eq, sql } from "drizzle-orm";
import { assistantUsage } from "@/db/schema";
import type { Database } from "@/db";
import { getConfig } from "@/lib/config";
import { todayIso } from "@/lib/date";

export interface QuotaView {
  limit: number;
  used: number;
  remaining: number;
}

export type QuotaResult = { ok: true } | { ok: false; error: "quota_exceeded" };

/** Requests already served by the user on `day`. */
export async function usedOn(db: Database, userId: string, day: string): Promise<number> {
  const [row] = await db
    .select({ count: assistantUsage.count })
    .from(assistantUsage)
    .where(and(eq(assistantUsage.userId, userId), eq(assistantUsage.day, day)))
    .limit(1);
  return row?.count ?? 0;
}

/** Remaining quota for the user on `day`, against ASSISTANT_DAILY_LIMIT. */
export async function getQuota(
  db: Database,
  userId: string,
  day: string = todayIso(),
): Promise<QuotaView> {
  const limit = getConfig().ASSISTANT_DAILY_LIMIT;
  const used = await usedOn(db, userId, day);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

/**
 * Typed gate: 'quota_exceeded' once the user reached the daily limit.
 * Checked BEFORE the LLM call so an exhausted user never costs a request.
 */
export async function assertQuota(
  db: Database,
  userId: string,
  day: string = todayIso(),
): Promise<QuotaResult> {
  const { ASSISTANT_DAILY_LIMIT: limit } = getConfig();
  const used = await usedOn(db, userId, day);
  return used >= limit ? { ok: false, error: "quota_exceeded" } : { ok: true };
}

/**
 * Atomically registers one use: INSERT count=1 or UPDATE count+1 on the
 * (user_id, day) unique key. Returns the new day count.
 */
export async function registerUse(
  db: Database,
  userId: string,
  day: string = todayIso(),
): Promise<number> {
  const [row] = await db
    .insert(assistantUsage)
    .values({ userId, day, count: 1 })
    .onConflictDoUpdate({
      target: [assistantUsage.userId, assistantUsage.day],
      set: { count: sql`${assistantUsage.count} + 1` },
    })
    .returning({ count: assistantUsage.count });
  return row?.count ?? 1;
}
