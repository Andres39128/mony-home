import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { themeInitScript } from "@/lib/theme-init";

/**
 * Static CSP hash for the shared theme-init inline script. Covers the copy
 * rendered by global-error — a Client Component that cannot read headers()
 * (docs: file-conventions/error, "Error boundaries must be Client
 * Components"). Hashes keep allowlisting inline scripts under
 * 'strict-dynamic' (CSP3). Derived at runtime from the shared const so it
 * cannot drift from the script it allows.
 */
const themeScriptHash = `'sha256-${createHash("sha256").update(themeInitScript).digest("base64")}'`;

/**
 * Per the bundled CSP guide (docs: content-security-policy), the header must
 * be set on BOTH the request (Next.js parses it during SSR, extracts the
 * nonce via the 'nonce-{value}' pattern and auto-attaches it to its
 * bootstrap/chunk scripts) and the response (what the browser enforces).
 * 'unsafe-eval' is dev-only: React uses eval there for error stacks.
 */
function buildCsp(nonce: string) {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${themeScriptHash} 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Cheap edge gate ONLY — no DB here (postgres.js cannot run in the proxy).
 * Presence of the cookie is checked, never its validity: real validation
 * happens server-side in the (app) layout via requireUser().
 *
 * Also issues the per-request CSP nonce (fresh nonce per request; reading
 * x-nonce via headers() in the root layout opts every route into dynamic
 * rendering, which nonce-based CSP requires anyway).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);

  // Request side: lets Next auto-nonce its own scripts and lets Server
  // Components read x-nonce (docs: content-security-policy#reading-the-nonce).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  const isLogin = request.nextUrl.pathname === "/login";

  if (!hasSessionCookie && !isLogin) {
    return withCsp(NextResponse.redirect(new URL("/login", request.url)), csp);
  }
  if (hasSessionCookie && isLogin) {
    return withCsp(NextResponse.redirect(new URL("/", request.url)), csp);
  }
  return withCsp(
    NextResponse.next({ request: { headers: requestHeaders } }),
    csp,
  );
}

function withCsp(response: NextResponse, csp: string) {
  response.headers.set("Content-Security-Policy", csp);
  return response;
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
