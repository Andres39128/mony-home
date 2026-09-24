import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default action body cap is 1MB; receipts allow up to 2MB plus
      // multipart overhead (see docs: serverActions.bodySizeLimit).
      bodySizeLimit: "3mb",
    },
  },
  // Global security headers on every route. CSP for HTML routes is issued
  // per-request (nonce + 'strict-dynamic') by src/proxy.ts (docs:
  // content-security-policy); /sw.js keeps its own strict CSP below.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera=(self): receipt capture scans codes/takes photos in-app.
          { key: "Permissions-Policy", value: "camera=(self)" },
        ],
      },
      {
        // Service worker header set from the bundled PWA guide
        // (docs: progressive-web-apps): always revalidated so clients pick up
        // updates, with a strict same-origin CSP.
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Content-Security-Policy",
            value: "default-src 'self'; script-src 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
