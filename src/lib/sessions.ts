/**
 * DB-backed session-row operations shared by the auth core (src/lib/auth)
 * and feature services (members). Kept separate from auth.ts so features
 * never import the login/lockout internals (the eslint layer boundaries
 * restrict value imports of `@/lib/auth` inside features).
 */
import { and, eq, ne } from "drizzle-orm";
import { sessions } from "@/db/schema";
import type { Database } from "@/db";

/**
 * Revoke every session of a user — run after credential rotation so a stolen
 * session cannot outlive a password change/reset (sessions carry no password
 * binding). `exceptTokenHash` keeps the caller's current session alive on the
 * self-service path; the admin reset path omits it to kill them all.
 */
export async function revokeUserSessions(
  // Accepts the pooled client or a transaction handle (structural, no cast).
  db: Pick<Database, "delete">,
  userId: string,
  exceptTokenHash?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      exceptTokenHash
        ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, exceptTokenHash))
        : eq(sessions.userId, userId),
    );
}
