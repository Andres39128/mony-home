import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default action body cap is 1MB; receipts allow up to 2MB plus
      // multipart overhead (see docs: serverActions.bodySizeLimit).
      bodySizeLimit: "3mb",
    },
  },
  // Service worker header set from the bundled PWA guide
  // (docs: progressive-web-apps): always revalidated so clients pick up
  // updates, with a strict same-origin CSP.
  async headers() {
    return [
      {
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
