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
  // PWA assets are excluded: pre-auth visitors (login page) still need the
  // manifest, icons and apple-touch icon for installability, and the service
  // worker (/sw.js) plus its /offline.html fallback must be fetchable with no
  // session. Everything app-related stays gated. `icon`/`apple-icon` (no
  // extension) are the Next file-convention routes for src/app/icon.svg and
  // src/app/apple-icon.png.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|sw\\.js|manifest\\.webmanifest|offline\\.html|icon\\.svg|icon-[\\w-]+\\.png|icon$|apple-icon).*)",
  ],
};
