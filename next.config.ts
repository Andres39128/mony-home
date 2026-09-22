import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Default action body cap is 1MB; receipts allow up to 2MB plus
      // multipart overhead (see docs: serverActions.bodySizeLimit).
      bodySizeLimit: "3mb",
    },
  },
};

export default nextConfig;
