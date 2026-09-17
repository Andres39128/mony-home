import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

/**
 * Cheap edge gate ONLY — no DB here (postgres.js cannot run in the proxy).
 * Presence of the cookie is checked, never its validity: real validation
 * happens server-side in the (app) layout via requireUser().
 */
export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  const isLogin = request.nextUrl.pathname === "/login";

  if (!hasSessionCookie && !isLogin) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (hasSessionCookie && isLogin) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
