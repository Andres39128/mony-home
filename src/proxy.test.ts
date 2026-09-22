import { describe, expect, it } from "vitest";
import { config } from "./proxy";

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
