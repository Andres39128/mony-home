import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { themeInitScript } from "@/lib/theme-init";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "mony-home",
  description: "Finanzas del hogar",
};

/** PWA theme color follows the page base (not honey) per scheme. */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f0" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1922" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Per-request nonce issued by src/proxy.ts (docs:
  // content-security-policy#reading-the-nonce). Reading headers() opts every
  // route into dynamic rendering — which nonce-based CSP requires anyway.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // suppressHydrationWarning: the inline script mutates <html> classes pre-paint.
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
