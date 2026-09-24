import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { config, proxy } from "./proxy";
import { themeInitScript } from "@/lib/theme-init";

// The matcher string is the full exclusion regex Next applies to pathnames:
// a path that MATCHES it gets the proxy (session gate); one that does not
// match is served directly with no session check.
const matcher = new RegExp(config.matcher[0]);

describe("proxy matcher", () => {
  it("still gates app routes and API endpoints", () => {
    for (const path of ["/", "/login", "/movimientos", "/api/receipts"]) {
      expect(matcher.test(path), path).toBe(true);
    }
  });

  it("never gates the service worker, manifest or static PWA assets", () => {
    for (const path of [
      "/sw.js",
      "/manifest.webmanifest",
      "/offline.html",
      "/icon.svg",
      "/icon-192.png",
      "/icon-maskable-512.png",
      "/icon",
      "/apple-icon",
    ]) {
      expect(matcher.test(path), path).toBe(false);
    }
  });
});

describe("proxy CSP", () => {
  const NONCE = /'nonce-([A-Za-z0-9+/=]+)'/;

  function cspOf(response: Response): string {
    const csp = response.headers.get("Content-Security-Policy");
    expect(csp, "CSP header must be present on matched routes").toBeTruthy();
    return csp as string;
  }

  /** Splits a CSP header into a directive-name → source-list map. */
  function directives(csp: string): Map<string, string[]> {
    return new Map(
      csp
        .split(";")
        .map((directive) => directive.trim())
        .filter(Boolean)
        .map((directive) => {
          const [name, ...sources] = directive.split(/\s+/);
          return [name, sources] as const;
        }),
    );
  }

  it("sets a CSP carrying a per-request nonce on a matched route", () => {
    const csp = cspOf(proxy(new NextRequest("http://localhost/login")));
    expect(NONCE.test(csp)).toBe(true);
  });

  it("issues different nonces to concurrent requests", async () => {
    const [a, b] = await Promise.all([
      proxy(new NextRequest("http://localhost/login")),
      proxy(new NextRequest("http://localhost/")),
    ]);
    const nonceA = NONCE.exec(cspOf(a))![1];
    const nonceB = NONCE.exec(cspOf(b))![1];
    expect(nonceA).not.toBe(nonceB);
  });

  it("carries the exact directive list", () => {
    const csp = cspOf(proxy(new NextRequest("http://localhost/login")));
    const nonce = `'nonce-${NONCE.exec(csp)![1]}'`;
    // The static hash must be derived from the actual theme-init script, or
    // global-error's inline copy would be blocked at runtime.
    const themeHash = `'sha256-${createHash("sha256").update(themeInitScript).digest("base64")}'`;
    // NODE_ENV is "test" here, so the dev-only 'unsafe-eval' must be absent.
    expect(directives(csp)).toEqual(
      new Map([
        ["default-src", ["'self'"]],
        ["script-src", ["'self'", nonce, themeHash, "'strict-dynamic'"]],
        ["style-src", ["'self'", "'unsafe-inline'"]],
        ["img-src", ["'self'", "data:", "blob:"]],
        ["font-src", ["'self'"]],
        ["connect-src", ["'self'"]],
        ["frame-ancestors", ["'none'"]],
        ["base-uri", ["'self'"]],
        ["form-action", ["'self'"]],
        ["object-src", ["'none'"]],
      ]),
    );
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("forwards the nonce to SSR via the request headers", () => {
    const realNext = NextResponse.next.bind(NextResponse);
    const spy = vi
      .spyOn(NextResponse, "next")
      .mockImplementation((init) => realNext(init));
    try {
      const response = proxy(new NextRequest("http://localhost/login"));
      const forwarded = spy.mock.calls[0]?.[0]?.request?.headers;
      expect(forwarded?.get("x-nonce")).toBe(NONCE.exec(cspOf(response))![1]);
      expect(forwarded?.get("Content-Security-Policy")).toBe(cspOf(response));
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the CSP header on redirect responses", () => {
    // No session cookie outside /login → redirect; the header still rides along.
    const response = proxy(new NextRequest("http://localhost/"));
    expect(response.status).toBe(307);
    expect(cspOf(response)).toMatch(NONCE);
  });
});
