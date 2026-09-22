import type { MetadataRoute } from "next";

/** Web app manifest for PWA installability (docs: progressive-web-apps). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "mony-home",
    short_name: "mony",
    description: "Finanzas del hogar",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf7f0",
    theme_color: "#ffe5a3",
    lang: "es",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
