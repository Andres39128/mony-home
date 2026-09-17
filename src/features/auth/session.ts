/**
 * Next.js glue for the auth core: cookie side-effects plus route guards.
 *
 * Everything DB-related lives in src/lib/auth.ts (pure-ish, clock-injectable,
 * tested against PGlite); this module only adapts it to next/headers.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  getSessionUser,
  type SessionUser,
} from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/session-cookie";

/** Persist the session cookie (Server Functions / Route Handlers only). */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  const maxAgeSec = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(maxAgeSec));
}

/** Remove the session cookie (Server Functions / Route Handlers only). */
export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE_NAME);
}

/**
 * Current session user from the request cookie, or null.
 * Applies sliding renewal to the DB session; the cookie maxAge is refreshed
 * opportunistically when the context allows it (see requireUser).
 */
export async function getOptionalUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const info = await getSessionUser(getDb(), token);
  return info?.user ?? null;
}

/**
 * Guard for (app) routes: redirects to /login without a valid session.
 *
 * When sliding renewal fires, the cookie is refreshed opportunistically:
 * setting cookies is only legal inside Server Functions, so during plain
 * renders the DB extension still applies and the refresh is a no-op. The
 * catch suppresses exactly that known render-context rejection; real
 * failures (e.g. a broken cookie store) still propagate as Next internals.
 */
export async function requireUser(): Promise<SessionUser> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) redirect("/login");

  const info = await getSessionUser(getDb(), token);
  if (!info) {
    // Drop the stale cookie when the context allows writes (Server Functions);
    // during plain renders the browser keeps it until the next logout/login.
    try {
      store.delete(SESSION_COOKIE_NAME);
    } catch {
      // Render context: cookies are read-only here.
    }
    redirect("/login");
  }

  if (info.renewed) {
    try {
      store.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(SESSION_TTL_MS / 1000));
    } catch {
      // Render context: cookies are read-only here; DB renewal already applied.
    }
  }
  return info.user;
}

export { ForbiddenError, requireAdmin } from "@/lib/auth";
