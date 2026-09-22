"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker. Production only (matches the
 * NODE_ENV gating in session-cookie.ts); registration failure is silent —
 * the app works fully without the SW, it only adds offline/asset caching.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error) => console.debug("Service worker registration skipped:", error));
  }, []);

  return null;
}
