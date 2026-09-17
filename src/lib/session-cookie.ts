/**
 * Session cookie descriptor — shared by the server glue and the edge proxy.
 *
 * Deliberately import-free: proxy.ts runs in a restricted runtime and must
 * not pull in the DB or Next server APIs.
 */
export const SESSION_COOKIE_NAME = "mony_session";

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/** Cookie attributes for a session lasting `maxAgeSec` seconds. */
export function sessionCookieOptions(maxAgeSec: number): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Trust boundary: `secure` matters only in production behind TLS.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}
